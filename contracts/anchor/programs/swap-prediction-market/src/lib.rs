use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

declare_id!("FkZVTshsawSNHYzxFZFfdBJUbLxvQJVhWtJqi8FgunFG");

const MARKET_SEED: &[u8] = b"market";
const ROUND_SEED: &[u8] = b"round";
const POSITION_SEED: &[u8] = b"position";

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
        let round = &mut ctx.accounts.round;

        require!(round.status == RoundStatus::Predicting as u8, ErrorCode::InvalidState);
        require!(clock.unix_timestamp < round.close_at_ts, ErrorCode::RoundClosed);
        if side == DecisionSide::Skip {
            require!(amount_lamports == 0, ErrorCode::InvalidAmount);
        } else {
            require!(amount_lamports > 0, ErrorCode::InvalidAmount);
        }

        match side {
            DecisionSide::Yes => {
                round.yes_total = round.yes_total.saturating_add(amount_lamports);
            }
            DecisionSide::No => {
                round.no_total = round.no_total.saturating_add(amount_lamports);
            }
            DecisionSide::Skip => {
                round.skip_total = round.skip_total.saturating_add(1);
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum AccountType {
    Market { admin: Pubkey, market_index: u16 },
    Round { market: Pubkey, round_number: u64 },
    Position { round: Pubkey, user: Pubkey },
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
    }
}
