use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::{invoke},
    system_instruction,
    instruction::Instruction,
};
use anchor_spl::token::{
    self, Token, TokenAccount, Mint, Transfer, MintTo, SetAuthority,
};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use spl_token::native_mint;
use spl_token::instruction as token_instruction;

declare_id!("uogw4oywo9nb4gyX6euzQgTHSkLLuiLc1FCEz4fpFHC");

pub fn pay_fee<'info>(use_sol: bool, payer: &AccountInfo<'info>, treasury_pda: &AccountInfo<'info>, payer_ata: Option<&AccountInfo<'info>>, treasury_ata: Option<&AccountInfo<'info>>, token_program: &AccountInfo<'info>, system_program: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    if use_sol {
        invoke(
            &system_instruction::transfer(
                &payer.key(),
                &treasury_pda.key(),
                amount,
            ),
            &[
                payer.clone(),
                treasury_pda.clone(),
                system_program.clone(),
            ],
        )?;
    } else {
        let payer_ata = payer_ata.ok_or(MarketplaceError::InvalidOwner)?;
        let treasury_ata = treasury_ata.ok_or(MarketplaceError::InvalidOwner)?;

        token::transfer(
            CpiContext::new(
                token_program.clone(),
                token::Transfer {
                    from: payer_ata.clone(),
                    to: treasury_ata.clone(),
                    authority: payer.clone(),
                },
            ),
            amount,
        )?;
    }
    Ok(())
}

#[program]
pub mod universe_of_gamers {
    use super::*;

    pub fn initialize_market(ctx: Context<InitializeMarket>, mint_fee_bps: u16, trade_fee_bps: u16, relist_fee_bps: u16, multisig_admins: Vec<Pubkey>, multisig_threshold: u8) -> Result<()> {
        require!(multisig_threshold > 0, MarketplaceError::InvalidThreshold);
        require!(
            multisig_threshold as usize <= multisig_admins.len() + 1,
            MarketplaceError::InvalidThreshold
        );

        let cfg = &mut ctx.accounts.market_config;
        cfg.admin = ctx.accounts.admin.key();
        cfg.mint_fee_bps = mint_fee_bps;
        cfg.trade_fee_bps = trade_fee_bps;
        cfg.relist_fee_bps = relist_fee_bps;
        cfg.treasury_bump = *ctx.bumps.get("treasury_pda").unwrap();
        cfg.multisig_admins = multisig_admins;
        cfg.multisig_threshold = multisig_threshold;

        Ok(())
    }

    pub fn initialize_treasury(_ctx: Context<InitializeTreasury>) -> Result<()> {
        Ok(())
    }

    pub fn mint_and_list(ctx: Context<MintAndList>, price: u64, use_sol: bool, mint_fee_spl: u64, _name: String, _symbol: String, _uri: String, _seller_fee_basis_points: u16) -> Result<()> {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.seller_nft_ata.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[&[
                    b"mint_auth",
                    ctx.accounts.mint.key().as_ref(),
                    &[*ctx.bumps.get("mint_authority").unwrap()],
                ]],
            ),
            1,
        )?;

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[&[
                    b"mint_auth",
                    ctx.accounts.mint.key().as_ref(),
                    &[*ctx.bumps.get("mint_authority").unwrap()],
                ]],
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        token::approve(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Approve {
                    to: ctx.accounts.seller_nft_ata.to_account_info(),
                    delegate: ctx.accounts.escrow_signer.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            1,
        )?;

        let mint_fee_bps = ctx.accounts.market_config.mint_fee_bps as u64;
        let expected_fee = price
            .saturating_mul(mint_fee_bps)
            .checked_div(10_000)
            .ok_or(MarketplaceError::MathOverflow)?;

        if use_sol {
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(
                    &ctx.accounts.seller.key(),
                    &ctx.accounts.treasury_pda.key(),
                    price,
                ),
                &[
                    ctx.accounts.seller.to_account_info(),
                    ctx.accounts.treasury_pda.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;

            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(
                    &ctx.accounts.seller.key(),
                    &ctx.accounts.admin.key(),
                    expected_fee,
                ),
                &[
                    ctx.accounts.seller.to_account_info(),
                    ctx.accounts.admin.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        } else {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.seller_payment_ata.to_account_info(),
                        to: ctx.accounts.treasury_token_account.to_account_info(),
                        authority: ctx.accounts.seller.to_account_info(),
                    },
                ),
                price,
            )?;

            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: ctx.accounts.seller_payment_ata.to_account_info(),
                        to: ctx.accounts.admin_token_account.to_account_info(),
                        authority: ctx.accounts.seller.to_account_info(),
                    },
                ),
                mint_fee_spl,
            )?;
        }

        let listing = &mut ctx.accounts.listing;
        listing.seller = ctx.accounts.seller.key();
        listing.nft_mint = ctx.accounts.mint.key();
        listing.price = price;
        listing.use_sol = use_sol;
        listing.bump = *ctx.bumps.get("listing").unwrap();

        Ok(())
    }

    pub fn buy_nft(ctx: Context<BuyNft>) -> Result<()> {
        let listing = &ctx.accounts.listing;

        require_keys_eq!(
            listing.seller,
            ctx.accounts.seller.key(),
            MarketplaceError::InvalidOwner
        );

        let trade_fee = listing
            .price
            .saturating_mul(ctx.accounts.market_config.trade_fee_bps as u64)
            / 10_000;
        let seller_amount = listing.price.saturating_sub(trade_fee);

        let buyer_payment_info = ctx.accounts.buyer_payment_ata.to_account_info();
        let seller_payment_info = ctx.accounts.seller_payment_ata.to_account_info();
        let _treasury_token_info = ctx.accounts.treasury_token_account.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let _system_program_info = ctx.accounts.system_program.to_account_info();

        let escrow_signer_bump = *ctx.bumps.get("escrow_signer").unwrap_or(&listing.bump);

        if ctx.accounts.buyer_payment_ata.key() == ctx.accounts.buyer.key() {
            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(
                    &ctx.accounts.buyer.key(),
                    &ctx.accounts.seller.key(),
                    seller_amount,
                ),
                &[
                    ctx.accounts.buyer.to_account_info(),
                    ctx.accounts.seller.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;

            anchor_lang::solana_program::program::invoke(
                &system_instruction::transfer(
                    &ctx.accounts.buyer.key(),
                    &ctx.accounts.treasury_pda.key(),
                    trade_fee,
                ),
                &[
                    ctx.accounts.buyer.to_account_info(),
                    ctx.accounts.treasury_pda.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        } else {
            token::transfer(
                CpiContext::new(
                    token_program_info.clone(),
                    token::Transfer {
                        from: buyer_payment_info.clone(),
                        to: seller_payment_info.clone(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                seller_amount,
            )?;

            token::transfer(
                CpiContext::new(
                    token_program_info.clone(),
                    token::Transfer {
                        from: buyer_payment_info.clone(),
                        to: _treasury_token_info.clone(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                trade_fee,
            )?;
        }

        let signer_seeds: &[&[u8]] = &[
            b"escrow_signer",
            listing.nft_mint.as_ref(),
            &[escrow_signer_bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.seller_nft_ata.to_account_info(),
                    to: ctx.accounts.buyer_nft_ata.to_account_info(),
                    authority: ctx.accounts.escrow_signer.to_account_info(),
                },
                &[signer_seeds],
            ),
            1,
        )?;

        Ok(())
    }

    pub fn withdraw_treasury(ctx: Context<WithdrawTreasury>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.market_config;
        let multisig_admins = &cfg.multisig_admins;

        let mut valid_signers = 0u8;

        if multisig_admins.contains(&ctx.accounts.admin.key()) {
            valid_signers += 1;
        }
        if multisig_admins.contains(&ctx.accounts.signer1.key()) {
            valid_signers += 1;
        }
        if multisig_admins.contains(&ctx.accounts.signer2.key()) {
            valid_signers += 1;
        }

        require!(valid_signers >= 2, MarketplaceError::Unauthorized);

        let is_native_sol = ctx.accounts.mint.key() == native_mint::ID;
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"treasury", &[ctx.accounts.market_config.treasury_bump]]];

        if is_native_sol {
            let treasury_info = &mut ctx.accounts.treasury_pda.to_account_info();
            let admin_info = &mut ctx.accounts.admin.to_account_info();
            **treasury_info.lamports.borrow_mut() -= amount;
            **admin_info.lamports.borrow_mut() += amount;
        } else {
            let treasury_token = ctx
                .accounts
                .treasury_token_account
                .as_ref()
                .expect("missing treasury_token_account");
            let admin_token = ctx
                .accounts
                .admin_token_account
                .as_ref()
                .expect("missing admin_token_account");

            let cpi_accounts = Transfer {
                from: treasury_token.to_account_info(),
                to: admin_token.to_account_info(),
                authority: ctx.accounts.treasury_pda.to_account_info(),
            };
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            );
            token::transfer(cpi_ctx, amount)?;
        }

        Ok(())
    }

    pub fn send_token(ctx: Context<SendToken>, amount: u64) -> Result<()> {
        let fee = amount
            .saturating_mul(ctx.accounts.market_config.trade_fee_bps as u64)
            / 10_000;
        let recipient_amount = amount.saturating_sub(fee);

        let use_sol = ctx.accounts.mint.key() == native_mint::id();

        let sender_token_info = ctx.accounts.sender_token_account.to_account_info();
        let recipient_token_info = ctx.accounts.recipient_token_account.to_account_info();
        let treasury_token_info = ctx.accounts.treasury_token_account.to_account_info();
        let token_program_info = ctx.accounts.token_program.to_account_info();
        let system_program_info = ctx.accounts.system_program.to_account_info();

        pay_fee(
            use_sol,
            &ctx.accounts.sender.to_account_info(),
            &ctx.accounts.recipient.to_account_info(),
            if use_sol { None } else { Some(&sender_token_info) },
            if use_sol { None } else { Some(&recipient_token_info) },
            &token_program_info,
            &system_program_info,
            recipient_amount,
        )?;

        pay_fee(
            use_sol,
            &ctx.accounts.sender.to_account_info(),
            &ctx.accounts.treasury_pda.to_account_info(),
            if use_sol { None } else { Some(&sender_token_info) },
            if use_sol { None } else { Some(&treasury_token_info) },
            &token_program_info,
            &system_program_info,
            fee,
        )?;

        Ok(())
    }

    pub fn swap_token(ctx: Context<SwapToken>, data: Vec<u8>, _in_amount: u64) -> Result<()> {
        let user_out_account_info = &ctx.remaining_accounts[0];
        let user_out_before;
        let output_mint;

        if let Ok(acc) = Account::<TokenAccount>::try_from(user_out_account_info) {
            require!(acc.owner == ctx.accounts.user.key(), MarketplaceError::InvalidOwner);
            user_out_before = acc.amount;
            output_mint = acc.mint;
        } else {
            user_out_before = user_out_account_info.lamports();
            output_mint = native_mint::id();
        }

        let ix = Instruction {
            program_id: ctx.accounts.dex_program.key(),
            accounts: ctx
                .remaining_accounts
                .iter()
                .map(|acc| AccountMeta {
                    pubkey: acc.key(),
                    is_signer: acc.is_signer,
                    is_writable: acc.is_writable,
                })
                .collect(),
            data,
        };
        invoke(&ix, &ctx.remaining_accounts)?;

        let user_out_after = if let Ok(acc) = Account::<TokenAccount>::try_from(user_out_account_info) {
            acc.amount
        } else {
            user_out_account_info.lamports()
        };

        let out_amount = user_out_after.saturating_sub(user_out_before);

        let trade_fee_bps = ctx.accounts.market_config.trade_fee_bps as u64;
        let trade_fee = out_amount.saturating_mul(trade_fee_bps) / 10_000;

        if trade_fee > 0 {
            let user_acc = ctx
                .remaining_accounts
                .iter()
                .find(|a| a.key() == ctx.accounts.user.key())
                .ok_or(MarketplaceError::InvalidOwner)?;

            let treasury_pda_acc = ctx
                .remaining_accounts
                .iter()
                .find(|a| a.key() == ctx.accounts.treasury_pda.key())
                .ok_or(MarketplaceError::InvalidOwner)?;

            let treasury_token_acc = ctx
                .remaining_accounts
                .iter()
                .find(|a| a.key() == ctx.accounts.treasury_token_account.key())
                .ok_or(MarketplaceError::InvalidOwner)?;

            if output_mint == native_mint::id() {
                let sys_acc = ctx
                    .remaining_accounts
                    .iter()
                    .find(|a| a.key() == anchor_lang::system_program::ID)
                    .ok_or(MarketplaceError::InvalidOwner)?;

                invoke(
                    &system_instruction::transfer(
                        &ctx.accounts.user.key(),
                        &ctx.accounts.treasury_pda.key(),
                        trade_fee,
                    ),
                    &[user_acc.clone(), treasury_pda_acc.clone(), sys_acc.clone()],
                )?;
            } else {
                let token_acc = ctx
                    .remaining_accounts
                    .iter()
                    .find(|a| a.key() == spl_token::ID)
                    .ok_or(MarketplaceError::InvalidOwner)?;

                let ix = token_instruction::transfer(
                    &spl_token::ID,
                    &ctx.accounts.user_out_token_account.key(),
                    &ctx.accounts.treasury_token_account.key(),
                    &ctx.accounts.user.key(),
                    &[],
                    trade_fee,
                )?;

                let user_out_acc = ctx
                    .remaining_accounts
                    .iter()
                    .find(|a| a.key() == ctx.accounts.user_out_token_account.key())
                    .ok_or(MarketplaceError::InvalidOwner)?;

                invoke(
                    &ix,
                    &[
                        user_out_acc.clone(),
                        treasury_token_acc.clone(),
                        user_acc.clone(),
                        token_acc.clone(),
                    ],
                )?;
            }
        }

        Ok(())
    }

    pub fn relist_nft(ctx: Context<RelistNft>, new_price: u64, use_sol: bool, relist_fee_spl: u64) -> Result<()> {
        let listing = &mut ctx.accounts.listing;

        require_keys_eq!(
            ctx.accounts.new_owner.key(),
            ctx.accounts.seller_nft_ata.owner,
            MarketplaceError::InvalidOwner
        );
        require_keys_eq!(
            listing.nft_mint,
            ctx.accounts.mint.key(),
            MarketplaceError::InvalidNFT
        );

        listing.seller = ctx.accounts.new_owner.key();
        listing.price = new_price;
        listing.use_sol = use_sol;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.seller_payment_ata.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.new_owner.to_account_info(),
                },
            ),
            relist_fee_spl,
        )?;

        token::approve(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Approve {
                    to: ctx.accounts.seller_nft_ata.to_account_info(),
                    delegate: ctx.accounts.escrow_signer.to_account_info(),
                    authority: ctx.accounts.new_owner.to_account_info(),
                },
            ),
            1,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct SwapToken<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: DEX aggregator program (e.g. DFLOW)
    pub dex_program: UncheckedAccount<'info>,

    #[account(mut)]
    pub market_config: Account<'info, MarketConfig>,

    #[account(
        mut,
        seeds = [b"treasury"],
        bump = market_config.treasury_bump
    )]
    /// CHECK: Treasury PDA (SOL & ATA authority)
    pub treasury_pda: AccountInfo<'info>,

    /// CHECK: No validation
    pub output_mint: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = treasury_pda
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = output_mint,
        associated_token::authority = user
    )]
    pub user_out_token_account: Account<'info, TokenAccount>,
}

#[account]
pub struct Listing {
    pub seller: Pubkey,
    pub nft_mint: Pubkey,
    pub price: u64,
    pub use_sol: bool,
    pub bump: u8,
}

#[account]
pub struct MarketConfig {
    pub admin: Pubkey,
    pub mint_fee_bps: u16,
    pub trade_fee_bps: u16,
    pub relist_fee_bps: u16,
    pub treasury_bump: u8,
    pub multisig_admins: Vec<Pubkey>,
    pub multisig_threshold: u8,
}

#[error_code]
pub enum MarketplaceError {
    #[msg("Invalid Owner")]
    InvalidOwner,
    #[msg("Invalid NFT")]
    InvalidNFT,    
    #[msg("Math Over flow")]
    MathOverflow,
    #[msg("InvalidThreshold")]
    InvalidThreshold,
    #[msg("Unauthorized action")]
    Unauthorized,
}

#[derive(Accounts)]
pub struct InitializeMarket<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 2 + 2 + 2 + 1 + 4 + (32 * 5) + 1,
        seeds = [b"market_config"],
        bump
    )]
    pub market_config: Account<'info, MarketConfig>,

    #[account(seeds = [b"treasury"], bump)]
    /// CHECK: only used as a PDA to store SOL/SPL
    pub treasury_pda: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeTreasury<'info> {
    #[account(
        init,
        payer = admin,
        space = 8,
        seeds = [b"treasury"],
        bump
    )]
    /// CHECK: only stores lamports
    pub treasury_pda: AccountInfo<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintAndList<'info> {
    #[account(
        init,
        payer = seller,
        space = 8 + 32 + 32 + 8 + 1 + 1,
        seeds = [b"listing", mint.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,

    #[account(
        seeds = [b"escrow_signer", mint.key().as_ref()],
        bump
    )]
    /// CHECK: PDA escrow signer for ATA approval
    pub escrow_signer: UncheckedAccount<'info>,

    /// Seller: signer
    #[account(mut)]
    pub seller: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    /// CHECK: Seller NFT ATA
    #[account(mut)]
    pub seller_nft_ata: UncheckedAccount<'info>,

    #[account(
        seeds = [b"mint_auth", mint.key().as_ref()],
        bump
    )]
    /// CHECK: PDA authority for mint
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [b"treasury"],
        bump = market_config.treasury_bump
    )]
    /// CHECK: PDA treasury to store lamports or SPL
    pub treasury_pda: UncheckedAccount<'info>,

    /// CHECK: Mint of payment SOL or SPL
    pub payment_mint: UncheckedAccount<'info>,

    /// CHECK: Mint SPL for fee
    pub spl_mint: UncheckedAccount<'info>,

    /// CHECK: Treasury ATA
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,

    /// CHECK: Seller payment ATA
    #[account(mut)]
    pub seller_payment_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub market_config: Account<'info, MarketConfig>,

    /// CHECK: Admin for SOL fee
    #[account(mut, address = market_config.admin)]
    pub admin: UncheckedAccount<'info>,

    /// CHECK: Admin for SPL fee
    #[account(mut)]
    pub admin_token_account: UncheckedAccount<'info>,

    /// CHECK: Metadata PDA of mint
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: Metaplex Metadata Program
    pub token_metadata_program: UncheckedAccount<'info>,

    /// CHECK: Update authority for metadata
    pub update_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: Rent sysvar
    pub rent: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyNft<'info> {
    #[account(mut)]
    pub listing: Account<'info, Listing>,

    #[account(mut)]
    pub buyer: Signer<'info>,

    /// CHECK: This is the seller wallet account.
    #[account(mut)]
    pub seller: AccountInfo<'info>,

    /// CHECK: This is the buyer ata or native wallet.
    #[account(mut)]
    pub buyer_payment_ata: AccountInfo<'info>,

    /// CHECK: This is the seller ata.
    #[account(mut)]
    pub seller_payment_ata: AccountInfo<'info>,

    /// CHECK: This is the treasury ata.
    #[account(mut)]
    pub treasury_token_account: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"treasury"],
        bump = market_config.treasury_bump
    )]
    /// CHECK:
    pub treasury_pda: AccountInfo<'info>,

    #[account(mut)]
    pub seller_nft_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub buyer_nft_ata: Account<'info, TokenAccount>,

    pub market_config: Account<'info, MarketConfig>,

    /// CHECK: add seed bump
    #[account(
        mut,
        seeds = [b"escrow_signer", listing.nft_mint.as_ref()],
        bump
    )]
    /// CHECK: Escrow signer PDA authorized for NFT transfer
    pub escrow_signer: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawTreasury<'info> {
    #[account(mut, has_one = admin)]
    pub market_config: Account<'info, MarketConfig>,

    /// CHECK: PDA treasury (authority)
    #[account(
        mut,
        seeds = [b"treasury"],
        bump = market_config.treasury_bump
    )]
    pub treasury_pda: AccountInfo<'info>,

    /// SPL mint (UOG, USDC, etc) or So111...
    /// CHECK: validated
    pub mint: AccountInfo<'info>,

    /// Token account treasury_pda
    #[account(mut)]
    pub treasury_token_account: Option<Account<'info, TokenAccount>>,

    /// Token account admin
    #[account(mut)]
    pub admin_token_account: Option<Account<'info, TokenAccount>>,

    /// Optional: legacy admin mode
    #[account(mut)]
    pub admin: Signer<'info>,

    /// Admin 1
    pub signer1: Signer<'info>,

    /// Admin 2
    pub signer2: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SendToken<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,

    /// CHECK: raw recipient account, validated in instruction logic
    #[account(mut)]
    pub recipient: AccountInfo<'info>,

    /// CHECK: treasury PDA validated manually in logic
    #[account(mut)]
    pub treasury_pda: AccountInfo<'info>,

    /// CHECK: token mint account
    pub mint: AccountInfo<'info>,

    /// CHECK: ATA of sender
    #[account(mut)]
    pub sender_token_account: AccountInfo<'info>,

    /// CHECK: ATA of recipient
    #[account(mut)]
    pub recipient_token_account: AccountInfo<'info>,

    /// CHECK: ATA of treasury
    #[account(mut)]
    pub treasury_token_account: AccountInfo<'info>,

    /// Market config
    pub market_config: Account<'info, MarketConfig>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RelistNft<'info> {
    #[account(
        mut,
        seeds = [b"listing", mint.key().as_ref()],
        bump = listing.bump,
        constraint = listing.nft_mint == mint.key() @ MarketplaceError::InvalidNFT
    )]
    pub listing: Account<'info, Listing>,

    #[account(mut)]
    pub new_owner: Signer<'info>,

    #[account(mut)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = seller_nft_ata.mint == mint.key() @ MarketplaceError::InvalidNFT,
        constraint = seller_nft_ata.owner == new_owner.key() @ MarketplaceError::InvalidOwner,
    )]
    pub seller_nft_ata: Account<'info, TokenAccount>,

    /// CHECK: Seller SPL ATA (UOG)
    #[account(mut)]
    pub seller_payment_ata: UncheckedAccount<'info>,

    /// CHECK: Treasury ATA SPL
    #[account(mut)]
    pub treasury_token_account: UncheckedAccount<'info>,

    #[account(
        seeds = [b"escrow_signer", mint.key().as_ref()],
        bump
    )]
    /// CHECK: PDA delegate authorized for NFT transfer
    pub escrow_signer: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}
