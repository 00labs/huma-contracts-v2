// For lender integration tests, we will have:
// Epoch period duration is Monthly

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import { LPConfigStructOutput } from "../../typechain-types/contracts/PoolConfig.sol/PoolConfig";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "../BaseTest";
import {
    evmRevert,
    evmSnapshot,
    getMinFirstLossCoverRequirement,
    overrideFirstLossCoverConfig,
    overrideLPConfig,
    toToken,
} from "../TestUtils";

// 2 initial lenders(jlender1, jlender2) in the junior tranche;
// 2 initial lenders(slender1, slender2) in the senior tranche.
// The number of lenders will change as the test progresses.

// 1 credit line

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let slender1: SignerWithAddress,
    slender2: SignerWithAddress,
    jlender1: SignerWithAddress,
    jlender2: SignerWithAddress,
    borrower: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

const POOL_PERIOD_DURATION = CONSTANTS.PERIOD_DURATION_MONTHLY;

const POOL_LIQUDITY_CAP = 1_050_000;
const MAX_SENIOR_JUNIOR_RATIO = 4;
const WITHDRAWAL_LOCKOUT_PERIOD_IN_DAYS = 30;

const LATE_PAYMENT_GRACE_PERIOD_IN_DAYS = 5;
const DEFAULT_GRACE_PERIOD_IN_MONTHS = 3;

const FRONT_LOADING_FEE_BPS = 100;
const YIELD_IN_BPS = 1200;
const LATE_FEE_BPS = 200;
const MIN_PRINCIPAL_RATE_IN_BPS = 500;

const PROTOCOL_FEE_IN_BPS = 1000;
const REWARD_RATE_IN_BPS_FOR_POOL_OWNER = 200;
const REWARD_RATE_IN_BPS_FOR_EA = 300;

const ADMIN_FIRST_LOSS_COVER_RISK_YIELD_MULTIPLIER = 1;

async function configPool(lpConfig: Partial<LPConfigStructOutput>) {
    await poolConfigContract.connect(poolOwner).setPoolPayPeriod(POOL_PERIOD_DURATION);
    await poolConfigContract
        .connect(poolOwner)
        .setLatePaymentGracePeriodInDays(LATE_PAYMENT_GRACE_PERIOD_IN_DAYS);
    await poolConfigContract
        .connect(poolOwner)
        .setPoolDefaultGracePeriod(DEFAULT_GRACE_PERIOD_IN_MONTHS);

    await overrideLPConfig(poolConfigContract, poolOwner, {
        liquidityCap: toToken(POOL_LIQUDITY_CAP),
        maxSeniorJuniorRatio: MAX_SENIOR_JUNIOR_RATIO,
        withdrawalLockoutPeriodInDays: WITHDRAWAL_LOCKOUT_PERIOD_IN_DAYS,
        ...lpConfig,
    });

    await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
        frontLoadingFeeFlat: 0,
        frontLoadingFeeBps: FRONT_LOADING_FEE_BPS,
    });

    await poolConfigContract.connect(poolOwner).setFeeStructure({
        yieldInBps: YIELD_IN_BPS,
        minPrincipalRateInBps: MIN_PRINCIPAL_RATE_IN_BPS,
        lateFeeBps: LATE_FEE_BPS,
    });

    await humaConfigContract.connect(protocolOwner).setTreasuryFee(PROTOCOL_FEE_IN_BPS);
    let adminRnR = await poolConfigContract.getAdminRnR();
    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerRewardsAndLiquidity(
            REWARD_RATE_IN_BPS_FOR_POOL_OWNER,
            adminRnR.liquidityRateInBpsByPoolOwner,
        );
    await poolConfigContract
        .connect(poolOwner)
        .setEARewardsAndLiquidity(REWARD_RATE_IN_BPS_FOR_EA, adminRnR.liquidityRateInBpsByEA);

    await overrideFirstLossCoverConfig(
        affiliateFirstLossCoverContract,
        CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
        poolConfigContract,
        poolOwner,
        { riskYieldMultiplier: ADMIN_FIRST_LOSS_COVER_RISK_YIELD_MULTIPLIER },
    );
}

describe("Lender Integration Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            slender1,
            slender2,
            jlender1,
            jlender2,
            borrower,
        ] = await ethers.getSigners();
    });

    let sId: unknown;

    after(async function () {
        if (sId) {
            await evmRevert(sId);
        }
    });

    describe("With RiskAdjustedTranchesPolicy", function () {
        const RISK_ADJUSTMENT_IN_BPS = 8000;

        let tranchesPolicyContract: RiskAdjustedTranchesPolicy;

        async function prepare() {
            [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                treasury,
                eaServiceAccount,
                pdsServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                affiliateFirstLossCoverContract,
                tranchesPolicyContract,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract as unknown,
                creditDueManagerContract,
                creditManagerContract as unknown,
            ] = await deployAndSetupPoolContracts(
                humaConfigContract,
                mockTokenContract,
                eaNFTContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "CreditLine",
                "BorrowerLevelCreditManager",
                evaluationAgent,
                poolOwnerTreasury,
                poolOperator,
                [slender1, slender2, jlender1, jlender2, borrower],
            );

            await borrowerFirstLossCoverContract
                .connect(poolOwner)
                .setCoverProvider(borrower.address, {
                    poolCapCoverageInBps: 1,
                    poolValueCoverageInBps: 100,
                });
            await mockTokenContract
                .connect(borrower)
                .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
            await borrowerFirstLossCoverContract
                .connect(borrower)
                .depositCover(
                    (
                        await getMinFirstLossCoverRequirement(
                            borrowerFirstLossCoverContract,
                            poolConfigContract,
                            poolContract,
                            borrower.address,
                        )
                    ).add(toToken(100)),
                );

            await configPool({ tranchesRiskAdjustmentInBps: RISK_ADJUSTMENT_IN_BPS });
        }

        before(async function () {
            await prepare();
            sId = await evmSnapshot();
        });

        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});

        it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {});

        it("Epoch 0, day after the epoch end date: Process yield and close epoch", async function () {});

        it("Epoch 1, day 3: Lenders in both tranches request redemption", async function () {});

        it("Epoch 1, day 10: Senior lenders put in additional redemption requests", async function () {});

        it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
            // All redemption requests are fulfilled.
        });

        it("Epoch 1, day after the epoch end date: Process yield, close epoch and the fulfillment of the redemption requests", async function () {});

        it("Epoch 2, day 6: New senior lenders inject liquidity", async function () {});

        it("Epoch 2, day 10: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});

        it("Epoch 2, day 15: New junior lenders inject liquidity", async function () {});

        it("Epoch 2, day 20: Senior lenders are now able to inject additional liquidity", async function () {});

        it("Epoch 2, day after the epoch end date: Close epoch, no fulfillment of the junior redemption requests", async function () {});

        it("Epoch 3, day 5: Late 3rd payment", async function () {});

        it("Epoch 3, day 10: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});

        it("Epoch 3, day 25: 4th payment by the borrower", async function () {});

        it("Epoch 3, day after the epoch end date: Process yield, close epoch and partial fulfillment of junior redemption requests", async function () {
            // The remaining requests are blocked by senior: junior ratio.
        });

        it("Epoch 4, day 2: Senior lenders request redemption", async function () {});

        it("Epoch 4, day 10: Pool admins withdraws fees", async function () {});

        it("Epoch 4, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {});

        it("Epoch 5, day 5: Late 5th payment", async function () {});

        it("Epoch 8, day 1: Default triggered and distribution of profit and loss", async function () {});

        it("Epoch 8, day 10: Lenders in both tranches provide liquidity", async function () {});

        it("Epoch 8, day 25: The borrower makes some payment back and distributes loss recovery", async function () {});

        it("Epoch 8, day after the epoch end date: Close epoch", async function () {});

        it("Epoch 9, day 2: Lenders in both tranches request full redemption", async function () {});

        it("Epoch 9, day after the epoch end date: Close epoch and the fulfillment of the redemption requests", async function () {});
    });

    describe("With FixedYieldTranchesPolicy", function () {
        // it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {});
        // it("Epoch 0, day 30: 1st payment by the borrower and distribution of profit", async function () {});
        // it("Epoch 1, day 35: Lenders in both tranches request redemption", async function () {});
        // it("Epoch 1, day 40: Senior lenders put in additional redemption requests", async function () {});
        // it("Epoch 1, day 60: 2nd payment by the borrower and the fulfillment of the redemption requests", async function () {
        //     // All redemption requests are fulfilled.
        // });
        // it("Epoch 2, day 65: New senior lenders inject liquidity", async function () {});
        // it("Epoch 2, day 70: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {});
        // it("Epoch 2, day 75: New junior lenders inject liquidity", async function () {});
        // it("Epoch 2, day 80: Senior lenders are now able to inject additional liquidity", async function () {});
        // it("Epoch 2, day 85: Junior lenders add redemption request", async function () {});
        // it("Epoch 2, day 90: No payment from the borrower, hence no fulfillment of the junior redemption requests", async function () {});
        // it("Epoch 3, day 95: Late 3rd payment", async function () {});
        // it("Epoch 3, day 120: No payment from the borrower, so only partial fulfillment of the junior redemption requests", async function () {});
        // it("Epoch 4, day 130: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {});
        // it("Epoch 4, day 150: 4th payment and partial fulfillment of junior redemption requests", async function () {
        //     // The remaining requests are blocked by senior: junior ratio.
        // });
        // it("Epoch 5, day 170: Senior lenders request redemption", async function () {});
        // it("Epoch 5, day 180: 5th payment and complete fulfillment of all redemption requests", async function () {});
        // it("Epoch 8, day 270: Default triggered due to late payment", async function () {});
        // it("Epoch 9, day 275: Lenders in both tranches submit redemption requests, loss materializes and first loss cover kicks in", async function () {});
        // it("Epoch 9, day 300: Redemption requests are fulfilled without loss", async function () {});
        // it("Epoch 10, day 307: More redemption requests are submitted, loss materializes and the junior tranche suffers loss", async function () {});
        // it("Epoch 10, day 330: Some redemption requests are fulfilled", async function () {});
        // it("Epoch 11, day 333: More redemption requests are submitted, loss materializes and the senior tranche suffers loss", async function () {});
        // it("Epoch 11, day 360: Some redemption requests are fulfilled", async function () {});
        // it("Epoch 12, day 361: The borrower makes some payment back", async function () {});
        // it("Epoch 12, day 365: New lenders injects additional liquidity into both tranches", async function () {});
        // it("Epoch 12, day 375: More redemption requests are submitted from old lenders", async function () {});
        // it("Epoch 12, day 390: Some redemption requests are fulfilled with some loss recovered", async function () {});
        // it("Epoch 13, day 393: The borrower makes full payment", async function () {});
        // it("Epoch 13, day 395: More redemption requests are submitted", async function () {});
        // it("Epoch 13, day 420: Redemption requests are fulfilled", async function () {});
    });
});
