use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use solana_sha256_hasher::hashv;

declare_id!("FkZVTshsawSNHYzxFZFfdBJUbLxvQJVhWtJqi8FgunFG");

const MARKET_SEED: &[u8] = b"market";
const ROUND_SEED: &[u8] = b"round";
const POSITION_SEED: &[u8] = b"position";
const MATCH_SEED: &[u8] = b"match";
const MATCH_ENTRY_SEED: &[u8] = b"match_entry";
const MARKET_ORACLE_SEED: &[u8] = b"market_oracle";
const HOUSE_BANKROLL_SEED: &[u8] = b"house_bankroll";
const AI_DUEL_SEED: &[u8] = b"ai_duel";
const AI_DUEL_COMMIT_DOMAIN: &[u8] = b"ubalance-ai-duel";
const MAX_AI_DUEL_TURNS: usize = 32;
const AI_DUEL_SIDE_UNSET: u8 = u8::MAX;
const SETTLEMENT_PRICE_SCALE_EXPONENT: i32 = -5;
const ORACLE_MAX_PRICE_AGE_SECONDS: u64 = 180;
const ORACLE_MAX_PUBLISH_LAG_SECONDS: i64 = 180;
const PROTOCOL_FEE_BPS: u64 = 250;
const BPS_DENOMINATOR: u64 = 10_000;
const MAX_MATCH_SCORING_ROUNDS: usize = 256;

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

    pub fn init_market_oracle(
        ctx: Context<InitMarketOracle>,
        oracle_feed_id: [u8; 32],
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);

        let market_oracle = &mut ctx.accounts.market_oracle;
        let is_uninitialized = market_oracle.market == Pubkey::default();
        if is_uninitialized {
            market_oracle.market = market.key();
            market_oracle.oracle_feed_id = oracle_feed_id;
            market_oracle.created_at_ts = Clock::get()?.unix_timestamp;
            return Ok(());
        }

        require_keys_eq!(market_oracle.market, market.key(), ErrorCode::InvalidMarketOracle);
        require!(
            market_oracle.oracle_feed_id == oracle_feed_id,
            ErrorCode::MarketOracleAlreadyInitialized
        );
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

    pub fn resolve_round(ctx: Context<ResolveRound>) -> Result<()> {
        let clock = Clock::get()?;
        let market = &ctx.accounts.market;
        let market_oracle = &ctx.accounts.market_oracle;
        let round = &mut ctx.accounts.round;

        require!(round.status == RoundStatus::Locked as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp >= round.close_at_ts, ErrorCode::RoundNotClosedYet);
        require_keys_eq!(market_oracle.market, market.key(), ErrorCode::InvalidMarketOracle);

        let price = ctx
            .accounts
            .oracle_price_feed
            .get_price_no_older_than(
                &clock,
                ORACLE_MAX_PRICE_AGE_SECONDS,
                &market_oracle.oracle_feed_id,
            )
            .map_err(|_| error!(ErrorCode::OraclePriceUnavailable))?;
        require!(
            price.publish_time >= round.close_at_ts,
            ErrorCode::OraclePublishBeforeRoundClose
        );
        require!(
            price.publish_time <= round.close_at_ts.saturating_add(ORACLE_MAX_PUBLISH_LAG_SECONDS),
            ErrorCode::OraclePublishTooLate
        );

        let total_pool = round.yes_total.saturating_add(round.no_total);
        let protocol_fee_lamports = calculate_protocol_fee_lamports(total_pool)?;
        if protocol_fee_lamports > 0 {
            transfer_lamports_from_program_account(
                &round.to_account_info(),
                &ctx.accounts.platform_fee_receiver.to_account_info(),
                protocol_fee_lamports,
                8 + Round::LEN,
            )?;
        }

        let settlement_price = normalize_oracle_price_to_internal_units(price.price, price.exponent)?;

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
        let protocol_fee_lamports = calculate_protocol_fee_lamports(total_pool)?;
        let distributable_pool = total_pool
            .checked_sub(protocol_fee_lamports)
            .ok_or(error!(ErrorCode::MathOverflow))?;
        require!(distributable_pool > 0, ErrorCode::NoPayoutAvailable);
        let payout_u128 = (position.amount_lamports as u128)
            .checked_mul(distributable_pool as u128)
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
        match_account.recorded_result_count = 0;
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

    pub fn set_match_entry_result(ctx: Context<SetMatchEntryResult>) -> Result<()> {
        let clock = Clock::get()?;
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;
        let entry = &mut ctx.accounts.match_entry;

        require_keys_eq!(match_account.market, market.key(), ErrorCode::InvalidMatchMarket);
        require!(match_account.status == MatchStatus::Locked as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp >= match_account.end_at_ts, ErrorCode::MatchNotEndedYet);
        require!(entry.joined, ErrorCode::MatchEntryNotJoined);
        require!(!entry.result_recorded, ErrorCode::MatchResultAlreadyRecorded);
        require!(
            match_account.recorded_result_count < match_account.player_count,
            ErrorCode::MatchResultsComplete
        );

        let remaining_count = ctx.remaining_accounts.len();
        require!(
            remaining_count % 2 == 0,
            ErrorCode::InvalidScoringAccounts
        );
        require!(
            remaining_count / 2 <= MAX_MATCH_SCORING_ROUNDS,
            ErrorCode::TooManyScoringRounds
        );

        let mut score: u16 = 0;
        let mut seen_rounds: Vec<Pubkey> = Vec::with_capacity(remaining_count / 2);
        let mut pair_index = 0usize;
        while pair_index < remaining_count {
            let round_info = &ctx.remaining_accounts[pair_index];
            let position_info = &ctx.remaining_accounts[pair_index + 1];
            pair_index += 2;

            require_keys_eq!(*round_info.owner, crate::ID, ErrorCode::InvalidScoringAccounts);
            require_keys_eq!(
                *position_info.owner,
                crate::ID,
                ErrorCode::InvalidScoringAccounts
            );
            require!(
                !seen_rounds.iter().any(|seen| seen == round_info.key),
                ErrorCode::DuplicateScoringRound
            );
            seen_rounds.push(*round_info.key);

            let round: Round = {
                let data = round_info
                    .try_borrow_data()
                    .map_err(|_| error!(ErrorCode::InvalidScoringRound))?;
                let mut data_slice: &[u8] = &data;
                Round::try_deserialize(&mut data_slice)
                    .map_err(|_| error!(ErrorCode::InvalidScoringRound))?
            };
            require_keys_eq!(round.market, market.key(), ErrorCode::InvalidScoringRound);
            require!(
                round.status == RoundStatus::Resolved as u8,
                ErrorCode::InvalidScoringRound
            );
            require!(
                round.close_at_ts >= match_account.start_at_ts
                    && round.close_at_ts <= match_account.end_at_ts,
                ErrorCode::InvalidScoringRound
            );

            let position: Position = {
                let data = position_info
                    .try_borrow_data()
                    .map_err(|_| error!(ErrorCode::InvalidScoringPosition))?;
                let mut data_slice: &[u8] = &data;
                Position::try_deserialize(&mut data_slice)
                    .map_err(|_| error!(ErrorCode::InvalidScoringPosition))?
            };
            require_keys_eq!(
                position.round,
                *round_info.key,
                ErrorCode::InvalidScoringPosition
            );
            require_keys_eq!(position.user, entry.player, ErrorCode::InvalidScoringPosition);
            if position.amount_lamports == 0 {
                continue;
            }

            let resolved_side = round
                .resolved_side
                .clone()
                .ok_or(error!(ErrorCode::RoundUnresolved))?;
            if resolved_side == DecisionSide::Skip {
                continue;
            }
            if position.side == resolved_side {
                score = score.checked_add(1).ok_or(error!(ErrorCode::MathOverflow))?;
            }
        }

        entry.score = score;
        entry.is_winner = false;
        entry.result_recorded = true;
        match_account.recorded_result_count = match_account.recorded_result_count.saturating_add(1);
        if score > match_account.highest_score {
            match_account.highest_score = score;
            match_account.winner_count = 1;
        } else if score == match_account.highest_score {
            match_account.winner_count = match_account.winner_count.saturating_add(1);
        }

        Ok(())
    }

    pub fn finalize_match(ctx: Context<FinalizeMatch>) -> Result<()> {
        let market = &ctx.accounts.market;
        let match_account = &mut ctx.accounts.match_account;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(match_account.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require!(match_account.status == MatchStatus::Locked as u8, ErrorCode::InvalidState);
        require!(
            match_account.recorded_result_count == match_account.player_count,
            ErrorCode::MatchResultsIncomplete
        );
        require!(match_account.winner_count > 0, ErrorCode::NoWinnersRecorded);

        let protocol_fee_lamports = calculate_protocol_fee_lamports(match_account.pot_lamports)?;
        if protocol_fee_lamports > 0 {
            transfer_lamports_from_program_account(
                &match_account.to_account_info(),
                &ctx.accounts.admin.to_account_info(),
                protocol_fee_lamports,
                8 + Match::LEN,
            )?;
        }

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
            require!(entry.result_recorded, ErrorCode::MatchResultsIncomplete);
            require!(
                entry.score == match_account.highest_score,
                ErrorCode::NotWinningPosition
            );
            require!(match_account.winner_count > 0, ErrorCode::NoWinnersRecorded);
            let protocol_fee_lamports = calculate_protocol_fee_lamports(match_account.pot_lamports)?;
            let distributable_pot = match_account
                .pot_lamports
                .checked_sub(protocol_fee_lamports)
                .ok_or(error!(ErrorCode::MathOverflow))?;
            require!(distributable_pot > 0, ErrorCode::NoPayoutAvailable);
            distributable_pot
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
        require_keys_eq!(round.market, market.key(), ErrorCode::InvalidDuelRound);
        require!(round.status == RoundStatus::Predicting as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp < round.close_at_ts, ErrorCode::RoundClosed);

        duel.admin = market.admin;
        duel.market = market.key();
        duel.round = round.key();
        duel.player = player.key();
        duel.duel_id = duel_id;
        duel.turn_count = 0;
        duel.total_amount_lamports = 0;
        duel.pot_lamports = 0;
        duel.turn_player_sides = [AI_DUEL_SIDE_UNSET; MAX_AI_DUEL_TURNS];
        duel.turn_ai_revealed_sides = [AI_DUEL_SIDE_UNSET; MAX_AI_DUEL_TURNS];
        duel.turn_amount_lamports = [0; MAX_AI_DUEL_TURNS];
        duel.turn_ai_commitments = [[0u8; 32]; MAX_AI_DUEL_TURNS];
        duel.status = DuelStatus::Open as u8;
        duel.outcome = None;
        duel.player_payout_lamports = 0;
        duel.player_claimed = false;
        duel.opened_at_ts = clock.unix_timestamp;
        duel.settled_at_ts = None;

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

        append_ai_duel_turn_state(duel, player_side, amount_lamports, ai_commitment)?;

        Ok(())
    }

    pub fn append_ai_duel_turn(
        ctx: Context<AppendAiDuelTurn>,
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
        require!(duel.status == DuelStatus::Open as u8, ErrorCode::InvalidState);
        require!(duel.duel_id == duel_id, ErrorCode::InvalidDuelTurn);
        require_keys_eq!(duel.market, market.key(), ErrorCode::InvalidDuelMarket);
        require_keys_eq!(duel.round, round.key(), ErrorCode::InvalidDuelRound);
        require_keys_eq!(duel.player, player.key(), ErrorCode::Unauthorized);
        require_keys_eq!(market.admin, bankroll.admin, ErrorCode::Unauthorized);
        require!(bankroll.active, ErrorCode::BankrollInactive);
        require_keys_eq!(round.market, market.key(), ErrorCode::InvalidDuelRound);
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

        append_ai_duel_turn_state(duel, player_side, amount_lamports, ai_commitment)?;

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
        require!(duel.turn_count == 1, ErrorCode::LegacyInstructionDisabled);

        let player_side = decision_side_from_u8(duel.turn_player_sides[0])?;
        let amount_lamports = duel.turn_amount_lamports[0];
        let side_u8 = decision_side_to_u8(&ai_side);
        let hash = hash_ai_duel_turn_commitment(
            duel,
            0,
            &player_side,
            amount_lamports,
            &ai_side,
            &nonce,
        );

        require!(
            duel.turn_ai_commitments[0] == hash,
            ErrorCode::AiCommitmentMismatch
        );

        duel.turn_ai_revealed_sides[0] = side_u8;
        duel.status = DuelStatus::Revealed as u8;
        Ok(())
    }

    pub fn settle_ai_duel(
        ctx: Context<SettleAiDuel>,
        ai_sides: Vec<DecisionSide>,
        nonces: Vec<[u8; 32]>,
    ) -> Result<()> {
        let market = &ctx.accounts.market;
        let round = &ctx.accounts.round;
        let bankroll = &ctx.accounts.house_bankroll;
        let duel = &mut ctx.accounts.ai_duel;

        require_keys_eq!(market.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(duel.admin, ctx.accounts.admin.key(), ErrorCode::Unauthorized);
        require_keys_eq!(bankroll.admin, market.admin, ErrorCode::Unauthorized);
        require!(
            duel.status == DuelStatus::Open as u8 || duel.status == DuelStatus::Revealed as u8,
            ErrorCode::InvalidState
        );
        require_keys_eq!(duel.market, market.key(), ErrorCode::InvalidDuelMarket);
        require_keys_eq!(duel.round, round.key(), ErrorCode::InvalidDuelRound);
        require!(round.status == RoundStatus::Resolved as u8, ErrorCode::RoundUnresolved);
        require!(duel.turn_count > 0, ErrorCode::InvalidDuelTurn);

        let expected_turn_count = duel.turn_count as usize;
        require!(
            ai_sides.len() == expected_turn_count && nonces.len() == expected_turn_count,
            ErrorCode::InvalidAiRevealInput
        );

        let winning_side = round
            .resolved_side
            .clone()
            .ok_or(error!(ErrorCode::RoundUnresolved))?;

        let mut player_payout_lamports: u64 = 0;
        for turn_index in 0..expected_turn_count {
            let player_side = decision_side_from_u8(duel.turn_player_sides[turn_index])?;
            let amount_lamports = duel.turn_amount_lamports[turn_index];
            let ai_side = ai_sides[turn_index].clone();
            let nonce = nonces[turn_index];
            let expected_commitment = hash_ai_duel_turn_commitment(
                duel,
                turn_index as u16,
                &player_side,
                amount_lamports,
                &ai_side,
                &nonce,
            );
            require!(
                duel.turn_ai_commitments[turn_index] == expected_commitment,
                ErrorCode::AiCommitmentMismatch
            );

            duel.turn_ai_revealed_sides[turn_index] = decision_side_to_u8(&ai_side);

            let turn_player_payout_lamports = resolve_ai_duel_turn_player_payout(
                player_side,
                ai_side,
                winning_side.clone(),
                amount_lamports,
            )?;
            player_payout_lamports = player_payout_lamports
                .checked_add(turn_player_payout_lamports)
                .ok_or(error!(ErrorCode::MathOverflow))?;
        }

        let house_payout = duel
            .pot_lamports
            .checked_sub(player_payout_lamports)
            .ok_or(error!(ErrorCode::MathOverflow))?;

        if house_payout > 0 {
            transfer_lamports_between_program_accounts(
                &duel.to_account_info(),
                &bankroll.to_account_info(),
                house_payout,
                8 + AIDuel::LEN,
            )?;
        }

        duel.outcome = Some(classify_ai_duel_outcome(
            player_payout_lamports,
            duel.total_amount_lamports,
        ));
        duel.player_payout_lamports = player_payout_lamports;
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
pub struct MarketOracleConfig {
    pub market: Pubkey,
    pub oracle_feed_id: [u8; 32],
    pub created_at_ts: i64,
}

impl MarketOracleConfig {
    pub const LEN: usize = 32 + 32 + 8;
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
    pub recorded_result_count: u8,
    pub created_at_ts: i64,
    pub finalized_at_ts: Option<i64>,
}

impl Match {
    pub const LEN: usize = 193;
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
    pub turn_count: u16,
    pub total_amount_lamports: u64,
    pub pot_lamports: u64,
    pub turn_player_sides: [u8; MAX_AI_DUEL_TURNS],
    pub turn_ai_revealed_sides: [u8; MAX_AI_DUEL_TURNS],
    pub turn_amount_lamports: [u64; MAX_AI_DUEL_TURNS],
    pub turn_ai_commitments: [[u8; 32]; MAX_AI_DUEL_TURNS],
    pub status: u8,
    pub outcome: Option<DuelOutcome>,
    pub player_payout_lamports: u64,
    pub player_claimed: bool,
    pub opened_at_ts: i64,
    pub settled_at_ts: Option<i64>,
}

impl AIDuel {
    pub const LEN: usize = 32
        + 32
        + 32
        + 32
        + 8
        + 2
        + 8
        + 8
        + MAX_AI_DUEL_TURNS
        + MAX_AI_DUEL_TURNS
        + (MAX_AI_DUEL_TURNS * 8)
        + (MAX_AI_DUEL_TURNS * 32)
        + 1
        + 2
        + 8
        + 1
        + 8
        + 9;
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
pub struct InitMarketOracle<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        seeds = [MARKET_SEED, admin.key().as_ref(), &market.index.to_le_bytes()],
        bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + MarketOracleConfig::LEN,
        seeds = [MARKET_ORACLE_SEED, market.key().as_ref()],
        bump,
    )]
    pub market_oracle: Account<'info, MarketOracleConfig>,
    pub system_program: Program<'info, System>,
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
    pub market: Account<'info, Market>,
    #[account(mut, address = market.admin)]
    pub platform_fee_receiver: SystemAccount<'info>,
    #[account(
        seeds = [MARKET_ORACLE_SEED, market.key().as_ref()],
        bump,
    )]
    pub market_oracle: Account<'info, MarketOracleConfig>,
    #[account(
        mut,
        seeds = [ROUND_SEED, market.key().as_ref(), &round.number.to_le_bytes()],
        bump,
    )]
    pub round: Account<'info, Round>,
    pub oracle_price_feed: Account<'info, PriceUpdateV2>,
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
    pub market: Box<Account<'info, Market>>,
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, market.admin.as_ref()],
        bump,
    )]
    pub house_bankroll: Box<Account<'info, HouseBankroll>>,
    #[account(
        init,
        payer = player,
        space = 8 + AIDuel::LEN,
        seeds = [AI_DUEL_SEED, market.key().as_ref(), player.key().as_ref(), &duel_id.to_le_bytes()],
        bump,
    )]
    pub ai_duel: Box<Account<'info, AIDuel>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct AppendAiDuelTurn<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, market.admin.as_ref()],
        bump,
    )]
    pub house_bankroll: Box<Account<'info, HouseBankroll>>,
    #[account(
        mut,
        seeds = [AI_DUEL_SEED, market.key().as_ref(), player.key().as_ref(), &duel_id.to_le_bytes()],
        bump,
    )]
    pub ai_duel: Box<Account<'info, AIDuel>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealAiDuel<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    #[account(mut)]
    pub ai_duel: Box<Account<'info, AIDuel>>,
}

#[derive(Accounts)]
pub struct SettleAiDuel<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub market: Box<Account<'info, Market>>,
    pub round: Box<Account<'info, Round>>,
    #[account(
        mut,
        seeds = [HOUSE_BANKROLL_SEED, market.admin.as_ref()],
        bump,
    )]
    pub house_bankroll: Box<Account<'info, HouseBankroll>>,
    #[account(mut)]
    pub ai_duel: Box<Account<'info, AIDuel>>,
}

#[derive(Accounts)]
pub struct ClaimAiDuelPayout<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(mut)]
    pub ai_duel: Box<Account<'info, AIDuel>>,
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
    #[msg("Round has not reached close time")]
    RoundNotClosedYet,
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
    #[msg("Invalid match market")]
    InvalidMatchMarket,
    #[msg("Invalid scoring accounts")]
    InvalidScoringAccounts,
    #[msg("Invalid scoring round")]
    InvalidScoringRound,
    #[msg("Invalid scoring position")]
    InvalidScoringPosition,
    #[msg("Duplicate scoring round")]
    DuplicateScoringRound,
    #[msg("Too many scoring rounds")]
    TooManyScoringRounds,
    #[msg("Match results are incomplete")]
    MatchResultsIncomplete,
    #[msg("Match results are already complete")]
    MatchResultsComplete,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("House bankroll inactive")]
    BankrollInactive,
    #[msg("AI commitment mismatch")]
    AiCommitmentMismatch,
    #[msg("Invalid AI reveal input")]
    InvalidAiRevealInput,
    #[msg("AI side has not been revealed")]
    AiNotRevealed,
    #[msg("Too many AI duel turns")]
    TooManyAiDuelTurns,
    #[msg("Invalid AI duel turn")]
    InvalidDuelTurn,
    #[msg("Legacy AI duel instruction is disabled for multi-turn duels")]
    LegacyInstructionDisabled,
    #[msg("Invalid duel market")]
    InvalidDuelMarket,
    #[msg("Invalid duel round")]
    InvalidDuelRound,
    #[msg("Market oracle config has already been initialized with a different feed")]
    MarketOracleAlreadyInitialized,
    #[msg("Invalid market oracle config")]
    InvalidMarketOracle,
    #[msg("Oracle price is unavailable")]
    OraclePriceUnavailable,
    #[msg("Oracle publish time is before round close")]
    OraclePublishBeforeRoundClose,
    #[msg("Oracle publish time is too far after round close")]
    OraclePublishTooLate,
    #[msg("Oracle price is invalid")]
    OracleInvalidPrice,
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

fn calculate_protocol_fee_lamports(total_pool_lamports: u64) -> Result<u64> {
    let fee_u128 = (total_pool_lamports as u128)
        .checked_mul(PROTOCOL_FEE_BPS as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    u64::try_from(fee_u128).map_err(|_| error!(ErrorCode::MathOverflow))
}

fn normalize_oracle_price_to_internal_units(price: i64, expo: i32) -> Result<u64> {
    require!(price > 0, ErrorCode::OracleInvalidPrice);
    let raw = u128::try_from(price).map_err(|_| error!(ErrorCode::OracleInvalidPrice))?;

    let scaled = if expo > SETTLEMENT_PRICE_SCALE_EXPONENT {
        let exponent_delta: u32 = (expo - SETTLEMENT_PRICE_SCALE_EXPONENT)
            .try_into()
            .map_err(|_| error!(ErrorCode::MathOverflow))?;
        let multiplier = 10u128
            .checked_pow(exponent_delta)
            .ok_or(error!(ErrorCode::MathOverflow))?;
        raw.checked_mul(multiplier)
            .ok_or(error!(ErrorCode::MathOverflow))?
    } else if expo < SETTLEMENT_PRICE_SCALE_EXPONENT {
        let exponent_delta: u32 = (SETTLEMENT_PRICE_SCALE_EXPONENT - expo)
            .try_into()
            .map_err(|_| error!(ErrorCode::MathOverflow))?;
        let divisor = 10u128
            .checked_pow(exponent_delta)
            .ok_or(error!(ErrorCode::MathOverflow))?;
        raw.checked_div(divisor)
            .ok_or(error!(ErrorCode::MathOverflow))?
    } else {
        raw
    };

    u64::try_from(scaled).map_err(|_| error!(ErrorCode::MathOverflow))
}

fn decision_side_to_u8(side: &DecisionSide) -> u8 {
    match side {
        DecisionSide::Yes => 0,
        DecisionSide::No => 1,
        DecisionSide::Skip => 2,
    }
}

fn decision_side_from_u8(raw: u8) -> Result<DecisionSide> {
    match raw {
        0 => Ok(DecisionSide::Yes),
        1 => Ok(DecisionSide::No),
        2 => Ok(DecisionSide::Skip),
        _ => Err(error!(ErrorCode::InvalidDuelTurn)),
    }
}

fn append_ai_duel_turn_state(
    duel: &mut AIDuel,
    player_side: DecisionSide,
    amount_lamports: u64,
    ai_commitment: [u8; 32],
) -> Result<()> {
    let turn_index = duel.turn_count as usize;
    require!(
        turn_index < MAX_AI_DUEL_TURNS,
        ErrorCode::TooManyAiDuelTurns
    );

    duel.turn_player_sides[turn_index] = decision_side_to_u8(&player_side);
    duel.turn_ai_revealed_sides[turn_index] = AI_DUEL_SIDE_UNSET;
    duel.turn_amount_lamports[turn_index] = amount_lamports;
    duel.turn_ai_commitments[turn_index] = ai_commitment;

    duel.turn_count = duel
        .turn_count
        .checked_add(1)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    duel.total_amount_lamports = duel
        .total_amount_lamports
        .checked_add(amount_lamports)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    duel.pot_lamports = duel
        .pot_lamports
        .checked_add(
            amount_lamports
                .checked_mul(2)
                .ok_or(error!(ErrorCode::MathOverflow))?,
        )
        .ok_or(error!(ErrorCode::MathOverflow))?;
    Ok(())
}

fn hash_ai_duel_turn_commitment(
    duel: &AIDuel,
    turn_index: u16,
    player_side: &DecisionSide,
    amount_lamports: u64,
    ai_side: &DecisionSide,
    nonce: &[u8; 32],
) -> [u8; 32] {
    let duel_id_le = duel.duel_id.to_le_bytes();
    let turn_index_le = turn_index.to_le_bytes();
    let player_side_raw = decision_side_to_u8(player_side);
    let ai_side_raw = decision_side_to_u8(ai_side);
    let amount_lamports_le = amount_lamports.to_le_bytes();

    hashv(&[
        AI_DUEL_COMMIT_DOMAIN,
        &duel_id_le,
        duel.player.as_ref(),
        duel.market.as_ref(),
        duel.round.as_ref(),
        &turn_index_le,
        &[player_side_raw],
        &amount_lamports_le,
        &[ai_side_raw],
        nonce,
    ])
    .to_bytes()
}

fn resolve_ai_duel_turn_player_payout(
    player_side: DecisionSide,
    ai_side: DecisionSide,
    winning_side: DecisionSide,
    amount_lamports: u64,
) -> Result<u64> {
    let player_correct = player_side == winning_side;
    let ai_correct = ai_side == winning_side;

    if player_correct && !ai_correct {
        amount_lamports
            .checked_mul(2)
            .ok_or(error!(ErrorCode::MathOverflow))
    } else if ai_correct && !player_correct {
        Ok(0)
    } else {
        Ok(amount_lamports)
    }
}

fn classify_ai_duel_outcome(player_payout_lamports: u64, total_stake_lamports: u64) -> DuelOutcome {
    if player_payout_lamports > total_stake_lamports {
        DuelOutcome::PlayerWin
    } else if player_payout_lamports < total_stake_lamports {
        DuelOutcome::HouseWin
    } else {
        DuelOutcome::Push
    }
}
