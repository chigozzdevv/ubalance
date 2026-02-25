use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use solana_sha256_hasher::hashv;

declare_id!("FkZVTshsawSNHYzxFZFfdBJUbLxvQJVhWtJqi8FgunFG");

const MARKET_SEED: &[u8] = b"market";
const ROUND_SEED: &[u8] = b"round";
const POSITION_SEED: &[u8] = b"position";
const MATCH_SEED: &[u8] = b"match";
const MATCH_ENTRY_SEED: &[u8] = b"match_entry";
const HOUSE_BANKROLL_SEED: &[u8] = b"house_bankroll";
const AI_DUEL_SEED: &[u8] = b"ai_duel";
const AI_DUEL_COMMIT_DOMAIN: &[u8] = b"ubalance-ai-duel";

#[ephemeral]
#[program]
pub mod ubalance_prediction_market {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        market_index: u16,
        name: String,
        timeframe_seconds: u32,
    ) -> Result<()> {
        require!(name.len() <= 64, ErrorCode::InvalidNameLength);
        require!(timeframe_seconds >= 10, ErrorCode::InvalidTimeframe);

        let market = &mut ctx.accounts.market;
        market.admin = ctx.accounts.admin.key();
        market.index = market_index;
        market.timeframe_seconds = timeframe_seconds;
        market.last_round = 0;
        market.is_active = true;
        market.name = name;
        Ok(())
    }

    pub fn set_market_active(ctx: Context<SetMarketActive>, is_active: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        market.is_active = is_active;
        Ok(())
    }

    pub fn open_round(
        ctx: Context<OpenRound>,
        reference_price: u64,
        open_at_ts: i64,
        close_at_ts: i64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(market.is_active, ErrorCode::MarketInactive);
        require!(close_at_ts > open_at_ts, ErrorCode::InvalidCloseTime);

        market.last_round = market.last_round.saturating_add(1);

        let round = &mut ctx.accounts.round;
        round.market = market.key();
        round.number = market.last_round;
        round.status = RoundStatus::Predicting as u8;
        round.reference_price = reference_price;
        round.settlement_price = None;
        round.open_at_ts = open_at_ts;
        round.close_at_ts = close_at_ts;
        round.resolved_side = None;
        round.yes_total = 0;
        round.no_total = 0;
        round.skip_total = 0;
        Ok(())
    }

    pub fn place_prediction(
        ctx: Context<PlacePrediction>,
        side: DecisionSide,
        amount_lamports: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let user = &ctx.accounts.user;
        let round = &mut ctx.accounts.round;
        let position = &mut ctx.accounts.position;

        require!(round.status == RoundStatus::Predicting as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp < round.close_at_ts, ErrorCode::RoundClosed);

        let is_uninitialized_position = position.user == Pubkey::default()
            && position.round == Pubkey::default()
            && position.amount_lamports == 0
            && !position.claimed;

        if is_uninitialized_position {
            position.user = user.key();
            position.round = round.key();
            position.side = side.clone();
            position.claimed = false;
        } else {
            require_keys_eq!(position.user, user.key(), ErrorCode::Unauthorized);
            require_keys_eq!(position.round, round.key(), ErrorCode::InvalidPositionRound);
            require!(!position.claimed, ErrorCode::PositionAlreadyClaimed);
            require!(position.side == side, ErrorCode::PositionSideMismatch);
            require!(side != DecisionSide::Skip, ErrorCode::PositionAlreadyPlaced);
        }

        if side == DecisionSide::Skip {
            require!(amount_lamports == 0, ErrorCode::InvalidAmount);
            round.skip_total = round.skip_total.saturating_add(1);
            return Ok(());
        }

        require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        let transfer_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: user.to_account_info(),
                to: round.to_account_info(),
            },
        );
        transfer(transfer_context, amount_lamports)?;
        position.amount_lamports = position.amount_lamports.saturating_add(amount_lamports);

        match side {
            DecisionSide::Yes => {
                round.yes_total = round.yes_total.saturating_add(amount_lamports);
            }
            DecisionSide::No => {
                round.no_total = round.no_total.saturating_add(amount_lamports);
            }
            DecisionSide::Skip => {
                return err!(ErrorCode::InvalidAmount);
            }
        }
        Ok(())
    }

    pub fn lock_round(ctx: Context<LockRound>) -> Result<()> {
        let market = &ctx.accounts.market;
        let round = &mut ctx.accounts.round;
        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(round.status == RoundStatus::Predicting as u8, ErrorCode::InvalidState);
        round.status = RoundStatus::Locked as u8;
        Ok(())
    }

    pub fn resolve_round(ctx: Context<ResolveRound>, settlement_price: u64) -> Result<()> {
        let market = &ctx.accounts.market;
        let round = &mut ctx.accounts.round;
        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(round.status == RoundStatus::Locked as u8, ErrorCode::InvalidState);

        round.settlement_price = Some(settlement_price);
        round.status = RoundStatus::Resolved as u8;
        round.resolved_side = Some(if settlement_price > round.reference_price {
            DecisionSide::Yes
        } else if settlement_price < round.reference_price {
            DecisionSide::No
        } else {
            DecisionSide::Skip
        });
        Ok(())
    }

    pub fn claim_payout(ctx: Context<ClaimPayout>) -> Result<()> {
        let round = &mut ctx.accounts.round;
        let position = &mut ctx.accounts.position;
        let user = &ctx.accounts.user;

        require!(round.status == RoundStatus::Resolved as u8, ErrorCode::InvalidState);
        require!(!position.claimed, ErrorCode::PositionAlreadyClaimed);
        require_keys_eq!(position.user, user.key(), ErrorCode::Unauthorized);
        require_keys_eq!(position.round, round.key(), ErrorCode::InvalidPositionRound);

        let winning_side = round
            .resolved_side
            .clone()
            .ok_or(error!(ErrorCode::RoundUnresolved))?;
        require!(position.side == winning_side, ErrorCode::NotWinningPosition);
        require!(position.amount_lamports > 0, ErrorCode::NoPayoutAvailable);

        let winners_total = match winning_side {
            DecisionSide::Yes => round.yes_total,
            DecisionSide::No => round.no_total,
            DecisionSide::Skip => 0,
        };
        require!(winners_total > 0, ErrorCode::NoPayoutAvailable);

        let total_pool = round.yes_total.saturating_add(round.no_total);
        let payout_u128 = (position.amount_lamports as u128)
            .checked_mul(total_pool as u128)
            .ok_or(error!(ErrorCode::MathOverflow))?
            .checked_div(winners_total as u128)
            .ok_or(error!(ErrorCode::MathOverflow))?;
        let payout_lamports = u64::try_from(payout_u128).map_err(|_| error!(ErrorCode::MathOverflow))?;
        require!(payout_lamports > 0, ErrorCode::NoPayoutAvailable);

        transfer_lamports_from_program_account(
            &round.to_account_info(),
            &user.to_account_info(),
            payout_lamports,
            8 + Round::LEN,
        )?;
        position.claimed = true;
        Ok(())
    }

    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: u64,
        buy_in_lamports: u64,
        max_players: u8,
        start_at_ts: i64,
        end_at_ts: i64,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        let admin = &ctx.accounts.admin;
        let match_account = &mut ctx.accounts.match_account;

        require_keys_eq!(market.admin, admin.key(), ErrorCode::Unauthorized);
        require!(market.is_active, ErrorCode::MarketInactive);
        require!(buy_in_lamports > 0, ErrorCode::InvalidAmount);
        require!(max_players >= 2, ErrorCode::InvalidMaxPlayers);
        require!(end_at_ts > start_at_ts, ErrorCode::InvalidCloseTime);

        let now_ts = Clock::get()?.unix_timestamp;
        require!(end_at_ts > now_ts, ErrorCode::MatchAlreadyEnded);

        match_account.admin = admin.key();
        match_account.market = market.key();
        match_account.match_id = match_id;
        match_account.buy_in_lamports = buy_in_lamports;
        match_account.max_players = max_players;
        match_account.player_count = 0;
        match_account.start_at_ts = start_at_ts;
        match_account.end_at_ts = end_at_ts;
        match_account.status = MatchStatus::Open as u8;
        match_account.pot_lamports = 0;
        match_account.winner_count = 0;
        match_account.highest_score = 0;
        match_account.created_at_ts = now_ts;
        match_account.finalized_at_ts = None;
        Ok(())
    }

    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let now_ts = Clock::get()?.unix_timestamp;
        let player = &ctx.accounts.player;
        let match_account = &mut ctx.accounts.match_account;
        let entry = &mut ctx.accounts.match_entry;

        require!(match_account.status == MatchStatus::Open as u8, ErrorCode::InvalidState);
        require!(now_ts < match_account.start_at_ts, ErrorCode::MatchAlreadyStarted);
        require!(now_ts < match_account.end_at_ts, ErrorCode::MatchAlreadyEnded);
        require!(
            match_account.player_count < match_account.max_players,
            ErrorCode::MatchAtCapacity
        );

        let is_uninitialized_entry = entry.player == Pubkey::default()
            && entry.match_account == Pubkey::default()
            && !entry.joined
            && !entry.claimed
            && !entry.result_recorded
            && !entry.is_winner
            && entry.buy_in_lamports == 0
            && entry.score == 0;

        require!(is_uninitialized_entry, ErrorCode::MatchAlreadyJoined);

        let transfer_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: player.to_account_info(),
                to: match_account.to_account_info(),
            },
        );
        transfer(transfer_context, match_account.buy_in_lamports)?;

        entry.match_account = match_account.key();
        entry.player = player.key();
        entry.buy_in_lamports = match_account.buy_in_lamports;
        entry.joined = true;
        entry.score = 0;
        entry.result_recorded = false;
        entry.is_winner = false;
        entry.claimed = false;
        entry.joined_at_ts = now_ts;
        entry.claimed_at_ts = None;

        match_account.player_count = match_account.player_count.saturating_add(1);
        match_account.pot_lamports = match_account
            .pot_lamports
            .saturating_add(match_account.buy_in_lamports);

        Ok(())
    }

    pub fn lock_match(ctx: Context<LockMatch>) -> Result<()> {
        let now_ts = Clock::get()?.unix_timestamp;
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(match_account.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(match_account.status == MatchStatus::Open as u8, ErrorCode::InvalidState);
        require!(now_ts >= match_account.end_at_ts, ErrorCode::MatchNotEndedYet);

        match_account.status = MatchStatus::Locked as u8;
        Ok(())
    }

    pub fn set_match_entry_result(
        ctx: Context<SetMatchEntryResult>,
        score: u16,
        is_winner: bool,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;
        let entry = &mut ctx.accounts.match_entry;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(match_account.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(match_account.status == MatchStatus::Locked as u8, ErrorCode::InvalidState);
        require!(entry.joined, ErrorCode::MatchEntryNotJoined);
        require!(!entry.result_recorded, ErrorCode::MatchResultAlreadyRecorded);

        entry.score = score;
        entry.is_winner = is_winner;
        entry.result_recorded = true;

        if is_winner {
            match_account.winner_count = match_account.winner_count.saturating_add(1);
        }
        if score > match_account.highest_score {
            match_account.highest_score = score;
        }

        Ok(())
    }

    pub fn finalize_match(ctx: Context<FinalizeMatch>) -> Result<()> {
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(match_account.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(match_account.status == MatchStatus::Locked as u8, ErrorCode::InvalidState);
        require!(match_account.winner_count > 0, ErrorCode::NoWinnersRecorded);

        match_account.status = MatchStatus::Resolved as u8;
        match_account.finalized_at_ts = Some(Clock::get()?.unix_timestamp);
        Ok(())
    }

    pub fn cancel_match(ctx: Context<FinalizeMatch>) -> Result<()> {
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(match_account.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(
            match_account.status == MatchStatus::Open as u8
                || match_account.status == MatchStatus::Locked as u8,
            ErrorCode::InvalidState
        );

        match_account.status = MatchStatus::Cancelled as u8;
        match_account.finalized_at_ts = Some(Clock::get()?.unix_timestamp);
        Ok(())
    }

    pub fn claim_match_payout(ctx: Context<ClaimMatchPayout>) -> Result<()> {
        let now_ts = Clock::get()?.unix_timestamp;
        let match_account = &mut ctx.accounts.match_account;
        let entry = &mut ctx.accounts.match_entry;
        let player = &ctx.accounts.player;

        require_keys_eq!(entry.player, player.key(), ErrorCode::Unauthorized);
        require_keys_eq!(entry.match_account, match_account.key(), ErrorCode::InvalidMatchEntry);
        require!(entry.joined, ErrorCode::MatchEntryNotJoined);
        require!(!entry.claimed, ErrorCode::AlreadyClaimed);

        let payout = if match_account.status == MatchStatus::Cancelled as u8 {
            entry.buy_in_lamports
        } else {
            require!(match_account.status == MatchStatus::Resolved as u8, ErrorCode::InvalidState);
            require!(entry.is_winner, ErrorCode::NotWinningPosition);
            require!(match_account.winner_count > 0, ErrorCode::NoWinnersRecorded);
            match_account
                .pot_lamports
                .checked_div(match_account.winner_count as u64)
                .ok_or(error!(ErrorCode::MathOverflow))?
        };

        require!(payout > 0, ErrorCode::NoPayoutAvailable);

        transfer_lamports_from_program_account(
            &match_account.to_account_info(),
            &player.to_account_info(),
            payout,
            8 + Match::LEN,
        )?;

        entry.claimed = true;
        entry.claimed_at_ts = Some(now_ts);
        Ok(())
    }

    pub fn init_house_bankroll(ctx: Context<InitHouseBankroll>) -> Result<()> {
        let bankroll = &mut ctx.accounts.house_bankroll;
        bankroll.admin = ctx.accounts.admin.key();
        bankroll.active = true;
        bankroll.created_at_ts = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn set_house_bankroll_active(
        ctx: Context<SetHouseBankrollActive>,
        active: bool,
    ) -> Result<()> {
        let bankroll = &mut ctx.accounts.house_bankroll;
        require_keys_eq!(bankroll.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        bankroll.active = active;
        Ok(())
    }

    pub fn fund_house_bankroll(
        ctx: Context<FundHouseBankroll>,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        let bankroll = &ctx.accounts.house_bankroll;
        require_keys_eq!(bankroll.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);

        let transfer_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.admin.to_account_info(),
                to: bankroll.to_account_info(),
            },
        );
        transfer(transfer_context, amount_lamports)?;
        Ok(())
    }

    pub fn withdraw_house_bankroll(
        ctx: Context<WithdrawHouseBankroll>,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        let bankroll = &ctx.accounts.house_bankroll;
        require_keys_eq!(bankroll.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);

        transfer_lamports_from_program_account(
            &bankroll.to_account_info(),
            &ctx.accounts.admin.to_account_info(),
            amount_lamports,
            8 + HouseBankroll::LEN,
        )?;
        Ok(())
    }

    pub fn open_ai_duel(
        ctx: Context<OpenAiDuel>,
        duel_id: u64,
        player_side: DecisionSide,
        amount_lamports: u64,
        ai_commitment: [u8; 32],
    ) -> Result<()> {
        let clock = Clock::get()?;
        let market = &ctx.accounts.market;
        let round = &ctx.accounts.round;
        let player = &ctx.accounts.player;
        let bankroll = &ctx.accounts.house_bankroll;
        let duel = &mut ctx.accounts.ai_duel;

        require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        require_keys_eq!(market.admin, bankroll.admin, ErrorCode::Unauthorized);
        require!(bankroll.active, ErrorCode::BankrollInactive);
        require!(round.status == RoundStatus::Predicting as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp < round.close_at_ts, ErrorCode::RoundClosed);

        let transfer_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: player.to_account_info(),
                to: duel.to_account_info(),
            },
        );
        transfer(transfer_context, amount_lamports)?;

        transfer_lamports_between_program_accounts(
            &bankroll.to_account_info(),
            &duel.to_account_info(),
            amount_lamports,
            8 + HouseBankroll::LEN,
        )?;

        duel.admin = market.admin;
        duel.market = market.key();
        duel.round = round.key();
        duel.player = player.key();
        duel.duel_id = duel_id;
        duel.player_side = player_side;
        duel.amount_lamports = amount_lamports;
        duel.pot_lamports = amount_lamports.saturating_mul(2);
        duel.ai_commitment = ai_commitment;
        duel.ai_revealed_side = None;
        duel.status = DuelStatus::Open as u8;
        duel.outcome = None;
        duel.player_payout_lamports = 0;
        duel.player_claimed = false;
        duel.opened_at_ts = clock.unix_timestamp;
        duel.settled_at_ts = None;

        Ok(())
    }

    pub fn reveal_ai_duel(
        ctx: Context<RevealAiDuel>,
        ai_side: DecisionSide,
        nonce: [u8; 32],
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        let duel = &mut ctx.accounts.ai_duel;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(duel.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(duel.status == DuelStatus::Open as u8, ErrorCode::InvalidState);

        let side_u8 = decision_side_to_u8(&ai_side);
        let duel_id_le = duel.duel_id.to_le_bytes();
        let hash = hashv(&[
            AI_DUEL_COMMIT_DOMAIN,
            &duel_id_le,
            duel.player.as_ref(),
            duel.market.as_ref(),
            duel.round.as_ref(),
            &[side_u8],
            &nonce,
        ]);

        require!(
            duel.ai_commitment == hash.to_bytes(),
            ErrorCode::AiCommitmentMismatch
        );

        duel.ai_revealed_side = Some(ai_side);
        duel.status = DuelStatus::Revealed as u8;
        Ok(())
    }

    pub fn settle_ai_duel(ctx: Context<SettleAiDuel>) -> Result<()> {
        let market = &ctx.accounts.market;
        let round = &ctx.accounts.round;
        let bankroll = &ctx.accounts.house_bankroll;
        let duel = &mut ctx.accounts.ai_duel;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(duel.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(bankroll.admin, market.admin, ErrorCode::Unauthorized);
        require!(duel.status == DuelStatus::Revealed as u8, ErrorCode::InvalidState);
        require_keys_eq!(duel.market, market.key(), ErrorCode::InvalidDuelMarket);
        require_keys_eq!(duel.round, round.key(), ErrorCode::InvalidDuelRound);
        require!(round.status == RoundStatus::Resolved as u8, ErrorCode::RoundUnresolved);

        let winning_side = round
            .resolved_side
            .clone()
            .ok_or(error!(ErrorCode::RoundUnresolved))?;
        let ai_side = duel
            .ai_revealed_side
            .clone()
            .ok_or(error!(ErrorCode::AiNotRevealed))?;

        let player_correct = duel.player_side == winning_side;
        let ai_correct = ai_side == winning_side;

        let (outcome, player_payout, house_payout) =
            if player_correct && !ai_correct {
                (DuelOutcome::PlayerWin, duel.pot_lamports, 0)
            } else if ai_correct && !player_correct {
                (DuelOutcome::HouseWin, 0, duel.pot_lamports)
            } else {
                // Tie/push: both sides get stake back.
                (
                    DuelOutcome::Push,
                    duel.amount_lamports,
                    duel.pot_lamports.saturating_sub(duel.amount_lamports),
                )
            };

        if house_payout > 0 {
            transfer_lamports_between_program_accounts(
                &duel.to_account_info(),
                &bankroll.to_account_info(),
                house_payout,
                8 + AIDuel::LEN,
            )?;
        }

        duel.outcome = Some(outcome);
        duel.player_payout_lamports = player_payout;
        duel.status = DuelStatus::Settled as u8;
        duel.settled_at_ts = Some(Clock::get()?.unix_timestamp);

        Ok(())
    }

    pub fn claim_ai_duel_payout(ctx: Context<ClaimAiDuelPayout>) -> Result<()> {
        let duel = &mut ctx.accounts.ai_duel;
        let player = &ctx.accounts.player;

        require!(duel.status == DuelStatus::Settled as u8, ErrorCode::InvalidState);
        require_keys_eq!(duel.player, player.key(), ErrorCode::Unauthorized);
        require!(!duel.player_claimed, ErrorCode::AlreadyClaimed);
        require!(duel.player_payout_lamports > 0, ErrorCode::NoPayoutAvailable);

        transfer_lamports_from_program_account(
            &duel.to_account_info(),
            &player.to_account_info(),
            duel.player_payout_lamports,
            8 + AIDuel::LEN,
        )?;

        duel.player_claimed = true;
        Ok(())
    }

    pub fn delegate_pda(ctx: Context<DelegatePda>, account_type: AccountType) -> Result<()> {
        let seed_data = derive_seeds_from_account_type(&account_type);
        let seed_refs: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();

        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &seed_refs,
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    pub fn commit_round(ctx: Context<RoundCommitCtx>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.round.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    pub fn commit_and_undelegate_round(ctx: Context<RoundCommitCtx>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.round.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }

    pub fn commit_and_undelegate_pda(
        ctx: Context<PdaCommitCtx>,
        account_type: AccountType,
    ) -> Result<()> {
        assert_account_matches_type(ctx.accounts.pda.key(), &account_type)?;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.pda.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DecisionSide {
    Yes,
    No,
    Skip,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum RoundStatus {
    Predicting,
    Locked,
    Resolved,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum MatchStatus {
    Open,
    Locked,
    Resolved,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DuelStatus {
    Open,
    Revealed,
    Settled,
    Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum DuelOutcome {
    PlayerWin,
    HouseWin,
    Push,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    Market { admin: Pubkey, market_index: u16 },
    Round { market: Pubkey, round_number: u64 },
    Position { round: Pubkey, user: Pubkey },
    Match { market: Pubkey, match_id: u64 },
    MatchEntry { match_account: Pubkey, player: Pubkey },
    HouseBankroll { admin: Pubkey },
    AIDuel {
        market: Pubkey,
        player: Pubkey,
        duel_id: u64,
    },
}

#[account]
pub struct Market {
    pub admin: Pubkey,
    pub index: u16,
    pub timeframe_seconds: u32,
    pub last_round: u64,
    pub is_active: bool,
    pub name: String,
}

impl Market {
    pub const LEN: usize = 32 + 2 + 4 + 8 + 1 + 4 + 64;
}

#[account]
pub struct Round {
    pub market: Pubkey,
    pub number: u64,
    pub status: u8,
    pub reference_price: u64,
    pub settlement_price: Option<u64>,
    pub open_at_ts: i64,
    pub close_at_ts: i64,
    pub resolved_side: Option<DecisionSide>,
    pub yes_total: u64,
    pub no_total: u64,
    pub skip_total: u64,
}

impl Round {
    pub const LEN: usize = 32 + 8 + 1 + 8 + 9 + 8 + 8 + 2 + 8 + 8 + 8;
}

#[account]
pub struct Position {
    pub user: Pubkey,
    pub round: Pubkey,
    pub side: DecisionSide,
    pub amount_lamports: u64,
    pub claimed: bool,
}

impl Position {
    pub const LEN: usize = 32 + 32 + 1 + 8 + 1;
}

#[account]
pub struct Match {
    pub admin: Pubkey,
    pub market: Pubkey,
    pub match_id: u64,
    pub buy_in_lamports: u64,
    pub max_players: u8,
    pub player_count: u8,
    pub start_at_ts: i64,
    pub end_at_ts: i64,
    pub status: u8,
    pub pot_lamports: u64,
    pub winner_count: u8,
    pub highest_score: u16,
    pub created_at_ts: i64,
    pub finalized_at_ts: Option<i64>,
}

impl Match {
    pub const LEN: usize = 192;
}

#[account]
pub struct MatchEntry {
    pub match_account: Pubkey,
    pub player: Pubkey,
    pub buy_in_lamports: u64,
    pub score: u16,
    pub joined: bool,
    pub result_recorded: bool,
    pub is_winner: bool,
    pub claimed: bool,
    pub joined_at_ts: i64,
    pub claimed_at_ts: Option<i64>,
}

impl MatchEntry {
    pub const LEN: usize = 128;
}

#[account]
pub struct HouseBankroll {
    pub admin: Pubkey,
    pub active: bool,
    pub created_at_ts: i64,
}

impl HouseBankroll {
    pub const LEN: usize = 64;
}

#[account]
pub struct AIDuel {
    pub admin: Pubkey,
    pub market: Pubkey,
    pub round: Pubkey,
    pub player: Pubkey,
    pub duel_id: u64,
    pub player_side: DecisionSide,
    pub amount_lamports: u64,
    pub pot_lamports: u64,
    pub ai_commitment: [u8; 32],
    pub ai_revealed_side: Option<DecisionSide>,
    pub status: u8,
    pub outcome: Option<DuelOutcome>,
    pub player_payout_lamports: u64,
    pub player_claimed: bool,
    pub opened_at_ts: i64,
    pub settled_at_ts: Option<i64>,
}

impl AIDuel {
    pub const LEN: usize = 256;
}

#[derive(Accounts)]
#[instruction(market_index: u16)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Market::LEN,
        seeds = [MARKET_SEED, admin.key().as_ref(), &market_index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMarketActive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [MARKET_SEED, admin.key().as_ref(), &market.index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct OpenRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [MARKET_SEED, admin.key().as_ref(), &market.index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = admin,
        space = 8 + Round::LEN,
        seeds = [ROUND_SEED, market.key().as_ref(), &market.last_round.saturating_add(1).to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlacePrediction<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::LEN,
        seeds = [POSITION_SEED, round.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [POSITION_SEED, round.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
}

#[derive(Accounts)]
pub struct LockRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
pub struct ResolveRound<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, admin.key().as_ref(), &market.index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = admin,
        space = 8 + Match::LEN,
        seeds = [MATCH_SEED, market.key().as_ref(), &match_id.to_le_bytes()],
        bump,
    )]
    pub match_account: Account<'info, Match>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub match_account: Account<'info, Match>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + MatchEntry::LEN,
        seeds = [MATCH_ENTRY_SEED, match_account.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub match_entry: Account<'info, MatchEntry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockMatch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub match_account: Account<'info, Match>,
}

#[derive(Accounts)]
pub struct SetMatchEntryResult<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [MATCH_ENTRY_SEED, match_account.key().as_ref(), match_entry.player.as_ref()],
        bump,
    )]
    pub match_entry: Account<'info, MatchEntry>,
}

#[derive(Accounts)]
pub struct FinalizeMatch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub match_account: Account<'info, Match>,
}

#[derive(Accounts)]
pub struct ClaimMatchPayout<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub match_account: Account<'info, Match>,
    #[account(
        mut,
        seeds = [MATCH_ENTRY_SEED, match_account.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub match_entry: Account<'info, MatchEntry>,
}

#[derive(Accounts)]
pub struct InitHouseBankroll<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + HouseBankroll::LEN,
        seeds = [HOUSE_BANKROLL_SEED, admin.key().as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetHouseBankrollActive<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, admin.key().as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
}

#[derive(Accounts)]
pub struct FundHouseBankroll<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, admin.key().as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHouseBankroll<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, admin.key().as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct OpenAiDuel<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub market: Account<'info, Market>,
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, market.admin.as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
    #[account(
        init,
        payer = player,
        space = 8 + AIDuel::LEN,
        seeds = [AI_DUEL_SEED, market.key().as_ref(), player.key().as_ref(), &duel_id.to_le_bytes()],
        bump,
    )]
    pub ai_duel: Account<'info, AIDuel>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealAiDuel<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub ai_duel: Account<'info, AIDuel>,
}

#[derive(Accounts)]
pub struct SettleAiDuel<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Account<'info, Market>,
    pub round: Account<'info, Round>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, market.admin.as_ref()],
        bump,
    )]
    pub house_bankroll: Account<'info, HouseBankroll>,
    #[account(mut)]
    pub ai_duel: Account<'info, AIDuel>,
}

#[derive(Accounts)]
pub struct ClaimAiDuelPayout<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub ai_duel: Account<'info, AIDuel>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePda<'info> {
    #[account(mut, del)]
    /// CHECK: validated by delegation program
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: checked by delegation program
    pub validator: Option<AccountInfo<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct RoundCommitCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
}

#[commit]
#[derive(Accounts)]
pub struct PdaCommitCtx<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    /// CHECK: validated via account_type seed derivation.
    pub pda: AccountInfo<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid state")]
    InvalidState,
    #[msg("Round already closed")]
    RoundClosed,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid market name length")]
    InvalidNameLength,
    #[msg("Invalid timeframe")]
    InvalidTimeframe,
    #[msg("Invalid close time")]
    InvalidCloseTime,
    #[msg("Market inactive")]
    MarketInactive,
    #[msg("Position side mismatch")]
    PositionSideMismatch,
    #[msg("Position already claimed")]
    PositionAlreadyClaimed,
    #[msg("Position already placed")]
    PositionAlreadyPlaced,
    #[msg("Position round mismatch")]
    InvalidPositionRound,
    #[msg("Position is not on the winning side")]
    NotWinningPosition,
    #[msg("No payout available")]
    NoPayoutAvailable,
    #[msg("Round unresolved")]
    RoundUnresolved,
    #[msg("Insufficient pool balance")]
    InsufficientPoolBalance,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid max players")]
    InvalidMaxPlayers,
    #[msg("Match has already started")]
    MatchAlreadyStarted,
    #[msg("Match has already ended")]
    MatchAlreadyEnded,
    #[msg("Match is at capacity")]
    MatchAtCapacity,
    #[msg("Match has not ended yet")]
    MatchNotEndedYet,
    #[msg("Match entry already joined")]
    MatchAlreadyJoined,
    #[msg("Match entry is not joined")]
    MatchEntryNotJoined,
    #[msg("Match result already recorded")]
    MatchResultAlreadyRecorded,
    #[msg("No winners recorded")]
    NoWinnersRecorded,
    #[msg("Invalid match entry")]
    InvalidMatchEntry,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("House bankroll inactive")]
    BankrollInactive,
    #[msg("AI commitment mismatch")]
    AiCommitmentMismatch,
    #[msg("AI side has not been revealed")]
    AiNotRevealed,
    #[msg("Invalid duel market")]
    InvalidDuelMarket,
    #[msg("Invalid duel round")]
    InvalidDuelRound,
    #[msg("Invalid PDA for account type")]
    InvalidPdaForAccountType,
}

fn derive_seeds_from_account_type(account_type: &AccountType) -> Vec<Vec<u8>> {
    match account_type {
        AccountType::Market { admin, market_index } => {
            vec![
                MARKET_SEED.to_vec(),
                admin.to_bytes().to_vec(),
                market_index.to_le_bytes().to_vec(),
            ]
        }
        AccountType::Round { market, round_number } => {
            vec![
                ROUND_SEED.to_vec(),
                market.to_bytes().to_vec(),
                round_number.to_le_bytes().to_vec(),
            ]
        }
        AccountType::Position { round, user } => {
            vec![
                POSITION_SEED.to_vec(),
                round.to_bytes().to_vec(),
                user.to_bytes().to_vec(),
            ]
        }
        AccountType::Match { market, match_id } => {
            vec![
                MATCH_SEED.to_vec(),
                market.to_bytes().to_vec(),
                match_id.to_le_bytes().to_vec(),
            ]
        }
        AccountType::MatchEntry {
            match_account,
            player,
        } => {
            vec![
                MATCH_ENTRY_SEED.to_vec(),
                match_account.to_bytes().to_vec(),
                player.to_bytes().to_vec(),
            ]
        }
        AccountType::HouseBankroll { admin } => {
            vec![HOUSE_BANKROLL_SEED.to_vec(), admin.to_bytes().to_vec()]
        }
        AccountType::AIDuel {
            market,
            player,
            duel_id,
        } => {
            vec![
                AI_DUEL_SEED.to_vec(),
                market.to_bytes().to_vec(),
                player.to_bytes().to_vec(),
                duel_id.to_le_bytes().to_vec(),
            ]
        }
    }
}

fn assert_account_matches_type(account_key: Pubkey, account_type: &AccountType) -> Result<()> {
    let seed_data = derive_seeds_from_account_type(account_type);
    let seed_refs: Vec<&[u8]> = seed_data.iter().map(|seed| seed.as_slice()).collect();
    let (expected, _) = Pubkey::find_program_address(&seed_refs, &crate::ID);
    require_keys_eq!(expected, account_key, ErrorCode::InvalidPdaForAccountType);
    Ok(())
}

fn transfer_lamports_from_program_account(
    source: &AccountInfo,
    destination: &AccountInfo,
    amount_lamports: u64,
    source_data_len: usize,
) -> Result<()> {
    let rent_minimum = Rent::get()?.minimum_balance(source_data_len);
    let source_lamports = **source.lamports.borrow();
    let transferable_lamports = source_lamports.saturating_sub(rent_minimum);

    require!(
        transferable_lamports >= amount_lamports,
        ErrorCode::InsufficientPoolBalance
    );

    **source.try_borrow_mut_lamports()? -= amount_lamports;
    **destination.try_borrow_mut_lamports()? += amount_lamports;
    Ok(())
}

fn transfer_lamports_between_program_accounts(
    source: &AccountInfo,
    destination: &AccountInfo,
    amount_lamports: u64,
    source_data_len: usize,
) -> Result<()> {
    let rent_minimum = Rent::get()?.minimum_balance(source_data_len);
    let source_lamports = **source.lamports.borrow();
    let transferable_lamports = source_lamports.saturating_sub(rent_minimum);

    require!(
        transferable_lamports >= amount_lamports,
        ErrorCode::InsufficientPoolBalance
    );

    **source.try_borrow_mut_lamports()? -= amount_lamports;
    **destination.try_borrow_mut_lamports()? += amount_lamports;
    Ok(())
}

fn decision_side_to_u8(side: &DecisionSide) -> u8 {
    match side {
        DecisionSide::Yes => 0,
        DecisionSide::No => 1,
        DecisionSide::Skip => 2,
    }
}
