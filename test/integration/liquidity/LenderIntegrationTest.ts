// For lender integration tests, we will have:
// Epoch period duration is Monthly

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    FixedSeniorYieldTranchePolicy,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import { LPConfigStructOutput } from "../../../typechain-types/contracts/common/PoolConfig.sol/PoolConfig";
import {
    CONSTANTS,
    EpochChecker,
    FeeCalculator,
    PayPeriodDuration,
    PnLCalculator,
    ProfitAndLossCalculator,
    SeniorYieldTracker,
    calcLateFee,
    checkRedemptionRecordByLender,
    checkSeniorYieldTrackersMatch,
    deployPoolContracts,
    deployProtocolContracts, CreditState
} from "../../BaseTest";
import {
    borrowerLevelCreditHash,
    evmRevert,
    evmSnapshot,
    getLatestBlock,
    overrideLPConfig,
    setNextBlockTimestamp,
    timestampToMoment,
    toToken,
} from "../../TestUtils";

// 2 initial lenders (jLender1, jLender2) in the junior tranche;
// 2 initial lenders (sLender1, sLender2) in the senior tranche.
// The number of lenders will change as the test progresses.
// 1 credit line

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let sLenders: SignerWithAddress[] = [],
    jLenders: SignerWithAddress[] = [],
    sActiveLenders: SignerWithAddress[] = [],
    jActiveLenders: SignerWithAddress[] = [],
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

let feeCalculator: FeeCalculator, pnlCalculator: ProfitAndLossCalculator;
let epochChecker: EpochChecker;

const POOL_PERIOD_DURATION = PayPeriodDuration.Monthly;

const POOL_LIQUIDITY_CAP = toToken(12_000_000);
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
const LIQUIDITY_RATE_IN_BPS_FOR_POOL_OWNER = 50;
const LIQUIDITY_RATE_IN_BPS_FOR_EA = 100;

const ADMIN_FIRST_LOSS_COVER_RISK_YIELD_MULTIPLIER_IN_BPS = 10000;

const NUM_JUNIOR_LENDERS = 3;
const NUM_SENIOR_LENDERS = 3;

let currentTS: number;
let creditHash: string;
let currentEpochId: BN;
let sLenderReinvests = [false, true, true],
    jLenderReinvests = [true, false, true];
let juniorShareRequested: BN = BN.from(0),
    seniorShareRequested: BN = BN.from(0);
let jLenderPrincipals: BN[] = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0)),
    sLenderPrincipals: BN[] = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
let jLenderShareRequests: BN[] = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0)),
    sLenderShareRequests: BN[] = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
let jLenderPrincipalRequests: BN[] = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0)),
    sLenderPrincipalRequests: BN[] = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
let jLenderAmountsProcessed: BN[] = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0)),
    sLenderAmountsProcessed: BN[] = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
let jLenderWithdrawals: BN[] = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0)),
    sLenderWithdrawals: BN[] = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));

async function configPool(lpConfig: Partial<LPConfigStructOutput>) {
    let settings = await poolConfigContract.getPoolSettings();
    await poolConfigContract.connect(poolOwner).setPoolSettings({
        ...settings,
        ...{
            maxCreditLine: POOL_LIQUIDITY_CAP,
            payPeriodDuration: POOL_PERIOD_DURATION,
            latePaymentGracePeriodInDays: LATE_PAYMENT_GRACE_PERIOD_IN_DAYS,
            defaultGracePeriodInDays: DEFAULT_GRACE_PERIOD_IN_MONTHS,
        },
    });

    await overrideLPConfig(poolConfigContract, poolOwner, {
        liquidityCap: POOL_LIQUIDITY_CAP,
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
    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerRewardsAndLiquidity(
            REWARD_RATE_IN_BPS_FOR_POOL_OWNER,
            LIQUIDITY_RATE_IN_BPS_FOR_POOL_OWNER,
        );
    await poolConfigContract
        .connect(poolOwner)
        .setEARewardsAndLiquidity(REWARD_RATE_IN_BPS_FOR_EA, LIQUIDITY_RATE_IN_BPS_FOR_EA);

    await poolConfigContract
        .connect(poolOwner)
        .setFirstLossCover(
            CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX,
            borrowerFirstLossCoverContract.address,
            {
                coverRatePerLossInBps: 1_000,
                coverCapPerLoss: toToken(10_000),
                maxLiquidity: toToken(250_000),
                minLiquidity: 0,
                riskYieldMultiplierInBps: 0,
            },
        );
    await poolConfigContract
        .connect(poolOwner)
        .setFirstLossCover(
            CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
            affiliateFirstLossCoverContract.address,
            {
                coverRatePerLossInBps: 1_000,
                coverCapPerLoss: toToken(30_000),
                maxLiquidity: toToken(250_000),
                minLiquidity: 0,
                riskYieldMultiplierInBps: ADMIN_FIRST_LOSS_COVER_RISK_YIELD_MULTIPLIER_IN_BPS,
            },
        );

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

    let eaNFTTokenId;
    const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
    const receipt = await tx.wait();
    for (const evt of receipt.events!) {
        if (evt.event === "NFTGenerated") {
            eaNFTTokenId = evt.args!.tokenId;
        }
    }
    await poolConfigContract
        .connect(poolOwner)
        .setEvaluationAgent(eaNFTTokenId, evaluationAgent.getAddress());

    const adminRnR = await poolConfigContract.getAdminRnR();
    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000));
    const poolOwnerLiquidity = BN.from(adminRnR.liquidityRateInBpsByPoolOwner)
        .mul(POOL_LIQUIDITY_CAP)
        .div(CONSTANTS.BP_FACTOR);
    await juniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolOwnerLiquidity);

    await mockTokenContract
        .connect(evaluationAgent)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(evaluationAgent.getAddress(), toToken(1_000_000_000));
    const evaluationAgentLiquidity = BN.from(adminRnR.liquidityRateInBpsByEA)
        .mul(POOL_LIQUIDITY_CAP)
        .div(CONSTANTS.BP_FACTOR);
    await juniorTrancheVaultContract
        .connect(evaluationAgent)
        .makeInitialDeposit(evaluationAgentLiquidity);

    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract
        .connect(evaluationAgent)
        .approve(affiliateFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(poolOwnerTreasury.getAddress());
    await affiliateFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(evaluationAgent.getAddress());

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(poolOwnerTreasury.address, true);
    await juniorTrancheVaultContract
        .connect(poolOperator)
        .setReinvestYield(evaluationAgent.address, true);

    // Deposit 1% of the pool liquidity cap as the first loss cover.
    await affiliateFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .depositCover(POOL_LIQUIDITY_CAP.div(100));
    await affiliateFirstLossCoverContract
        .connect(evaluationAgent)
        .depositCover(POOL_LIQUIDITY_CAP.div(100));
    await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);

    const accounts = [...sLenders, ...jLenders, borrower];
    for (let i = 0; i < accounts.length; i++) {
        await juniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await seniorTrancheVaultContract
            .connect(poolOperator)
            .addApprovedLender(accounts[i].getAddress(), true);
        await mockTokenContract
            .connect(accounts[i])
            .approve(poolSafeContract.address, ethers.constants.MaxUint256);
        await mockTokenContract
            .connect(accounts[i])
            .approve(creditContract.address, ethers.constants.MaxUint256);
        await mockTokenContract.mint(accounts[i].getAddress(), toToken(1_000_000_000));
    }

    await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
    await mockTokenContract
        .connect(borrower)
        .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await borrowerFirstLossCoverContract.connect(borrower).depositCover(toToken(100));

    for (let i = 0; i < jLenders.length; i++) {
        let reinvestYield = (await juniorTrancheVaultContract.depositRecords(jLenders[i].address))
            .reinvestYield;
        if (reinvestYield != jLenderReinvests[i]) {
            await juniorTrancheVaultContract
                .connect(poolOperator)
                .setReinvestYield(jLenders[i].address, jLenderReinvests[i]);
        }
    }
    for (let i = 0; i < sLenders.length; i++) {
        let reinvestYield = (await seniorTrancheVaultContract.depositRecords(sLenders[i].address))
            .reinvestYield;
        if (reinvestYield != sLenderReinvests[i]) {
            await seniorTrancheVaultContract
                .connect(poolOperator)
                .setReinvestYield(sLenders[i].address, sLenderReinvests[i]);
        }
    }

    feeCalculator = new FeeCalculator(humaConfigContract, poolConfigContract);
    pnlCalculator = new ProfitAndLossCalculator(poolConfigContract, poolContract, [
        borrowerFirstLossCoverContract,
        affiliateFirstLossCoverContract,
    ]);
    epochChecker = new EpochChecker(
        epochManagerContract,
        seniorTrancheVaultContract,
        juniorTrancheVaultContract,
    );
}

async function checkPoolFees(
    oldFees: BN[],
    protocolReward: BN,
    poolOwnerReward: BN,
    eaReward: BN,
) {
    let newFees = await poolFeeManagerContract.getAccruedIncomes();
    expect(newFees[0]).to.equal(oldFees[0].add(protocolReward));
    expect(newFees[1]).to.equal(oldFees[1].add(poolOwnerReward));
    expect(newFees[2]).to.equal(oldFees[2].add(eaReward));
}

async function checkAssetsForProfit(
    expectedTranchesAssets: BN[],
    expectedFirstLossCoverProfits: BN[],
    borrowerFLCOldBalance: BN,
    affiliateFLCOldBalance: BN,
) {
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE],
    );
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
    );
    expect(expectedFirstLossCoverProfits[CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX]).to.equal(0);
    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(borrowerFLCOldBalance);
    expect(
        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
    ).to.greaterThan(0);
    expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
        affiliateFLCOldBalance.add(
            expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
        ),
    );
}

async function checkAssetsForLoss(
    expectedTranchesAssets: BN[],
    expectedFirstLossCoverLosses: BN[],
    borrowerFLCOldBalance: BN,
    affiliateFLCOldBalance: BN,
) {
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE],
    );
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
    );
    expect(expectedFirstLossCoverLosses[CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX]).to.lessThan(0);
    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
        borrowerFLCOldBalance.add(
            expectedFirstLossCoverLosses[CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX],
        ),
    );
    expect(expectedFirstLossCoverLosses[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX]).to.lessThan(
        0,
    );
    expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
        affiliateFLCOldBalance.add(
            expectedFirstLossCoverLosses[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
        ),
    );
}

async function checkUserAssets(expectedTranchesAssets: BN[]) {
    let juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
    for (let i = 0; i < jActiveLenders.length; i++) {
        expect(await juniorTrancheVaultContract.totalAssetsOf(jActiveLenders[i].address)).to.equal(
            (await juniorTrancheVaultContract.balanceOf(jActiveLenders[i].address))
                .mul(expectedTranchesAssets[CONSTANTS.JUNIOR_TRANCHE])
                .div(juniorTotalSupply),
        );
    }

    let seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
    for (let i = 0; i < sActiveLenders.length; i++) {
        expect(await seniorTrancheVaultContract.totalAssetsOf(sActiveLenders[i].address)).to.equal(
            (await seniorTrancheVaultContract.balanceOf(sActiveLenders[i].address))
                .mul(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE])
                .div(seniorTotalSupply),
        );
    }
}

async function testYieldPayout() {
    let interests: BN[] = [],
        oldBalances: BN[] = [];
    for (let i = 0; i < jActiveLenders.length; i++) {
        interests[i] = (
            await juniorTrancheVaultContract.totalAssetsOf(jActiveLenders[i].address)
        ).sub(jLenderPrincipals[i]);
        oldBalances[i] = await mockTokenContract.balanceOf(jActiveLenders[i].address);
    }
    await juniorTrancheVaultContract.processYieldForLenders();
    for (let i = 0; i < jActiveLenders.length; i++) {
        if (interests[i].gt(0)) {
            if (!jLenderReinvests[i]) {
                expect(
                    await juniorTrancheVaultContract.totalAssetsOf(jActiveLenders[i].address),
                ).to.closeTo(jLenderPrincipals[i], 1);
                expect(await mockTokenContract.balanceOf(jActiveLenders[i].address)).to.equal(
                    oldBalances[i].add(interests[i]),
                );
                jLenderPrincipals[i] = (
                    await juniorTrancheVaultContract.depositRecords(jActiveLenders[i].address)
                ).principal;
            } else {
                expect(await mockTokenContract.balanceOf(jActiveLenders[i].address)).to.equal(
                    oldBalances[i],
                );
                let newPrincipal = (
                    await juniorTrancheVaultContract.depositRecords(jActiveLenders[i].address)
                ).principal;
                expect(newPrincipal).to.equal(jLenderPrincipals[i]);
                jLenderPrincipals[i] = newPrincipal;
            }
        }
    }

    for (let i = 0; i < sActiveLenders.length; i++) {
        interests[i] = (
            await seniorTrancheVaultContract.totalAssetsOf(sActiveLenders[i].address)
        ).sub(sLenderPrincipals[i]);
        oldBalances[i] = await mockTokenContract.balanceOf(sActiveLenders[i].address);
    }
    await seniorTrancheVaultContract.processYieldForLenders();
    for (let i = 0; i < sActiveLenders.length; i++) {
        if (interests[i].gt(0)) {
            if (!sLenderReinvests[i]) {
                expect(
                    await seniorTrancheVaultContract.totalAssetsOf(sActiveLenders[i].address),
                ).to.closeTo(sLenderPrincipals[i], 1);
                expect(await mockTokenContract.balanceOf(sActiveLenders[i].address)).to.equal(
                    oldBalances[i].add(interests[i]),
                );
                sLenderPrincipals[i] = (
                    await seniorTrancheVaultContract.depositRecords(sActiveLenders[i].address)
                ).principal;
            } else {
                expect(await mockTokenContract.balanceOf(sActiveLenders[i].address)).to.equal(
                    oldBalances[i],
                );
                let [newPrincipal] = await seniorTrancheVaultContract.depositRecords(
                    sActiveLenders[i].address,
                );
                expect(newPrincipal).to.equal(sLenderPrincipals[i]);
                sLenderPrincipals[i] = newPrincipal;
            }
        }
    }
}

async function testRedemptionRequest(jLenderRequests: BN[], sLenderRequests: BN[]) {
    for (let i = 0; i < jLenderRequests.length; i++) {
        if (jLenderRequests[i].gt(0)) {
            let oldShares = await juniorTrancheVaultContract.balanceOf(jLenders[i].address);
            await juniorTrancheVaultContract
                .connect(jLenders[i])
                .addRedemptionRequest(jLenderRequests[i]);
            expect(await juniorTrancheVaultContract.balanceOf(jLenders[i].address)).to.equal(
                oldShares.sub(jLenderRequests[i]),
            );
            let [newPrincipal] = await juniorTrancheVaultContract.depositRecords(
                jLenders[i].address,
            );
            let principalRequested = jLenderPrincipals[i].mul(jLenderRequests[i]).div(oldShares);
            let expectedNewPrincipal = jLenderPrincipals[i].sub(principalRequested);
            expect(newPrincipal).to.equal(expectedNewPrincipal);
            jLenderShareRequests[i] = jLenderShareRequests[i].add(jLenderRequests[i]);
            jLenderPrincipalRequests[i] = jLenderPrincipalRequests[i].add(principalRequested);
            jLenderPrincipals[i] = newPrincipal;
            await checkRedemptionRecordByLender(
                juniorTrancheVaultContract,
                jLenders[i],
                currentEpochId,
                jLenderShareRequests[i],
                jLenderPrincipalRequests[i],
                jLenderAmountsProcessed[i],
                jLenderWithdrawals[i],
                2,
            );
            expect(
                await juniorTrancheVaultContract.cancellableRedemptionShares(jLenders[i].address),
            ).to.closeTo(jLenderShareRequests[i], 1);
            juniorShareRequested = juniorShareRequested.add(jLenderRequests[i]);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                BN.from(0),
                BN.from(0),
                1,
            );
        }
    }

    for (let i = 0; i < sLenderRequests.length; i++) {
        if (sLenderRequests[i].gt(0)) {
            let oldShares = await seniorTrancheVaultContract.balanceOf(sLenders[i].address);
            await seniorTrancheVaultContract
                .connect(sLenders[i])
                .addRedemptionRequest(sLenderRequests[i]);
            expect(await seniorTrancheVaultContract.balanceOf(sLenders[i].address)).to.equal(
                oldShares.sub(sLenderRequests[i]),
            );
            let [newPrincipal] = await seniorTrancheVaultContract.depositRecords(
                sLenders[i].address,
            );
            let principalRequested = sLenderPrincipals[i].mul(sLenderRequests[i]).div(oldShares);
            let expectedNewPrincipal = sLenderPrincipals[i].sub(principalRequested);
            expect(newPrincipal).to.closeTo(expectedNewPrincipal, 1);
            sLenderShareRequests[i] = sLenderShareRequests[i].add(sLenderRequests[i]);
            sLenderPrincipalRequests[i] = sLenderPrincipalRequests[i].add(principalRequested);
            sLenderPrincipals[i] = newPrincipal;
            await checkRedemptionRecordByLender(
                seniorTrancheVaultContract,
                sLenders[i],
                currentEpochId,
                sLenderShareRequests[i],
                sLenderPrincipalRequests[i],
                sLenderAmountsProcessed[i],
                sLenderWithdrawals[i],
            );
            expect(
                await seniorTrancheVaultContract.cancellableRedemptionShares(sLenders[i].address),
            ).to.equal(sLenderShareRequests[i]);
            seniorShareRequested = seniorShareRequested.add(sLenderRequests[i]);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
            );
        }
    }
}

describe("Lender Integration Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            sLenders[0],
            sLenders[1],
            sLenders[2],
            jLenders[0],
            jLenders[1],
            jLenders[2],
            borrower,
        ] = await ethers.getSigners();
    });

    let sId: unknown;

    const JLENDER1_INITIAL_AMOUNT = 1_200_000;
    const JLENDER2_INITIAL_AMOUNT = 800_000;
    const SLENDER1_INITIAL_AMOUNT = 5_000_000;
    const SLENDER2_INITIAL_AMOUNT = 3_000_000;
    const BORROWER_INITIAL_AMOUNT = 10_000_000;

    let jLenderInitialAmounts = [JLENDER1_INITIAL_AMOUNT, JLENDER2_INITIAL_AMOUNT];
    let sLenderInitialAmounts = [SLENDER1_INITIAL_AMOUNT, SLENDER2_INITIAL_AMOUNT];

    describe("With RiskAdjustedTranchesPolicy", function () {
        const RISK_ADJUSTMENT_IN_BPS = 8000;
        let tranchesPolicyContract: RiskAdjustedTranchesPolicy;

        async function prepare() {
            [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                treasury,
                eaServiceAccount,
                sentinelServiceAccount,
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
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "CreditLine",
                "BorrowerLevelCreditManager",
            );

            await configPool({ tranchesRiskAdjustmentInBps: RISK_ADJUSTMENT_IN_BPS });
        }

        before(async function () {
            sId = await evmSnapshot();
            await prepare();
        });

        after(async function () {
            if (sId) {
                await evmRevert(sId);
            }
            juniorShareRequested = BN.from(0);
            seniorShareRequested = BN.from(0);
            jLenderPrincipals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderPrincipals = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderShareRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderShareRequests = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderPrincipalRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderPrincipalRequests = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderAmountsProcessed = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderAmountsProcessed = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderWithdrawals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderWithdrawals = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            sActiveLenders = [];
            jActiveLenders = [];
        });

        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {
            let block = await getLatestBlock();
            currentTS =
                timestampToMoment(block.timestamp, "YYYY-MM-01").add(1, "month").unix() + 300;
            await setNextBlockTimestamp(currentTS);
            await poolContract.connect(poolOwner).enablePool();

            for (let i = 0; i < jLenderInitialAmounts.length; i++) {
                let oldBalance = await mockTokenContract.balanceOf(jLenders[i].address);
                await juniorTrancheVaultContract
                    .connect(jLenders[i])
                    .deposit(toToken(jLenderInitialAmounts[i]), jLenders[i].address);
                expect(await mockTokenContract.balanceOf(jLenders[i].address)).to.equal(
                    oldBalance.sub(toToken(jLenderInitialAmounts[i])),
                );
                expect(
                    await juniorTrancheVaultContract.totalAssetsOf(jLenders[i].address),
                ).to.equal(toToken(jLenderInitialAmounts[i]));
                jLenderPrincipals[i] = toToken(jLenderInitialAmounts[i]);
                jActiveLenders.push(jLenders[i]);
            }

            for (let i = 0; i < sLenderInitialAmounts.length; i++) {
                let oldBalance = await mockTokenContract.balanceOf(sLenders[i].address);
                await seniorTrancheVaultContract
                    .connect(sLenders[i])
                    .deposit(toToken(sLenderInitialAmounts[i]), sLenders[i].address);
                expect(await mockTokenContract.balanceOf(sLenders[i].address)).to.equal(
                    oldBalance.sub(toToken(sLenderInitialAmounts[i])),
                );
                expect(
                    await seniorTrancheVaultContract.totalAssetsOf(sLenders[i].address),
                ).to.equal(toToken(sLenderInitialAmounts[i]));
                sLenderPrincipals[i] = toToken(sLenderInitialAmounts[i]);
                sActiveLenders.push(sLenders[i]);
            }

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(BORROWER_INITIAL_AMOUNT),
                    11,
                    YIELD_IN_BPS,
                    0,
                    0,
                    true,
                );

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract
                .connect(borrower)
                .drawdown(borrower.address, toToken(BORROWER_INITIAL_AMOUNT));
            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(toToken(BORROWER_INITIAL_AMOUNT));
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncrement = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .sub(toToken(BORROWER_INITIAL_AMOUNT))
                    .add(expectedPoolSafeBalanceIncrement),
            );

            await checkUserAssets(expectedTranchesAssets);

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {
            currentTS += 28 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue;

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            // cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 0, day after the epoch end date: Process yield and close epoch", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let oldEpochId = await epochManagerContract.currentEpochId();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(oldEpochId.add(1));
            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 1, day 3: Lenders in both tranches request redemption", async function () {
            currentTS = currentTS + 2 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [toToken(100), toToken(200)],
                [toToken(300), toToken(300)],
            );
        });

        it("Epoch 1, day 10: Senior lenders put in additional redemption requests", async function () {
            currentTS = currentTS + 7 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(200), toToken(100)]);
        });

        it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
            currentTS = currentTS + 15 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue;

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);

            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 1, day after the epoch end date: Process yield, close epoch and the fulfillment of the redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                juniorOldShares.sub(juniorShareRequested),
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.sub(jAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance.add(jAmountProcessed),
            );
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                jLenderAmountsProcessed[i] = jAmountProcessed
                    .mul(jLenderShareRequests[i])
                    .div(juniorShareRequested);
                jLenderShareRequests[i] = BN.from(0);
                jLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[i].address),
                ).to.equal(jLenderAmountsProcessed[i]);
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                sLenderAmountsProcessed[i] = sAmountProcessed
                    .mul(sLenderShareRequests[i])
                    .div(seniorShareRequested);
                sLenderShareRequests[i] = BN.from(0);
                sLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sActiveLenders[i].address),
                ).to.equal(sLenderAmountsProcessed[i]);
            }
            seniorShareRequested = BN.from(0);

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 2, day 6: New senior lenders inject liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            await seniorTrancheVaultContract
                .connect(sLenders[2])
                .deposit(amount, sLenders[2].address);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address)).to.closeTo(
                amount,
                1,
            );
            sLenderPrincipals[2] = amount;
            sActiveLenders.push(sLenders[2]);
        });

        it("Epoch 2, day 10: Senior lenders attempt to inject liquidity, but blocked by senior : junior ratio", async function () {
            currentTS = currentTS + 4 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            await expect(
                seniorTrancheVaultContract
                    .connect(sLenders[2])
                    .deposit(toToken(600_000), sLenders[2].address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "trancheLiquidityCapExceeded",
            );
        });

        it("Epoch 2, day 15: New junior lenders inject liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(30_000);

            let oldBalance = await mockTokenContract.balanceOf(jLenders[2].address);
            await juniorTrancheVaultContract
                .connect(jLenders[2])
                .deposit(amount, jLenders[2].address);
            expect(await mockTokenContract.balanceOf(jLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await juniorTrancheVaultContract.totalAssetsOf(jLenders[2].address)).to.closeTo(
                amount,
                1,
            );
            jLenderPrincipals[2] = amount;
            jActiveLenders.push(jLenders[2]);
        });

        it("Epoch 2, day 20: Senior lenders are now able to inject additional liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            let oldAssets = await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address);
            await seniorTrancheVaultContract
                .connect(sLenders[2])
                .deposit(amount, sLenders[2].address);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address)).to.closeTo(
                oldAssets.add(amount),
                1,
            );
            sLenderPrincipals[2] = sLenderPrincipals[2].add(amount);
        });

        it("Epoch 2, day after the epoch end date: Close epoch, no fulfillment of the junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await juniorTrancheVaultContract.processYieldForLenders();
            await seniorTrancheVaultContract.processYieldForLenders();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await epochChecker.checkJuniorCurrentEpochEmpty();
            await epochChecker.checkSeniorCurrentEpochEmpty();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorOldShares);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance,
            );

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 3, day 6: Late 3rd payment", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 3, day 10: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {
            currentTS = currentTS + 4 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(150_000)], []);
        });

        it("Epoch 3, day 25: 4th payment by the borrower", async function () {
            currentTS = currentTS + 15 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let cc = await creditManagerContract.getCreditConfig(creditHash);

            let [, lateFee] = await calcLateFee(
                poolConfigContract,
                calendarContract,
                cc,
                cr,
                dd,
                currentTS,
            );

            let profit = cr.yieldDue.add(dd.yieldPastDue).add(lateFee);
            let payment = cr.nextDue.add(cr.totalPastDue).add(lateFee).sub(dd.lateFee);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            // cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);

            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 3, day after the epoch end date: Process yield, close epoch and partial fulfillment of junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            // The remaining requests are blocked by senior: junior ratio.
            let seniorAssets = await seniorTrancheVaultContract.totalAssets();
            let minJuniorAssets = seniorAssets.div(MAX_SENIOR_JUNIOR_RATIO);
            let jAmountProcessed = (await juniorTrancheVaultContract.totalAssets()).sub(
                minJuniorAssets,
            );
            let jShareProcessed =
                await juniorTrancheVaultContract.convertToShares(jAmountProcessed);

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(jShareProcessed),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                jShareProcessed,
                jAmountProcessed,
                1,
            );

            jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
            jLenderShareRequests[0] = juniorShareRequested.sub(jShareProcessed);
            jLenderPrincipalRequests[0] = jLenderPrincipalRequests[0]
                .mul(jLenderShareRequests[0])
                .div(juniorShareRequested);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
            ).to.closeTo(jLenderAmountsProcessed[0], 1);
            juniorShareRequested = jLenderShareRequests[0];

            // console.log(
            //     `jLenderAmountsProcessed[0]: ${jLenderAmountsProcessed[0]}, jLenderShareRequests[0]: ${jLenderShareRequests[0]}, jLenderPrincipalRequests[0]: ${jLenderPrincipalRequests[0]}`,
            // );

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 4, day 2: Senior lenders request redemption", async function () {
            currentTS = currentTS + 1 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(200_000), toToken(100_000)]);
        });

        it("Epoch 4, day 10: Pool admins withdraw fees", async function () {
            currentTS = currentTS + 8 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            // console.log(`currentTS: ${currentTS}`);

            let amount = toToken(100);

            let oldBalance = await mockTokenContract.balanceOf(treasury.address);
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(protocolOwner).withdrawProtocolFee(amount);
            expect(await mockTokenContract.balanceOf(treasury.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );

            oldBalance = await mockTokenContract.balanceOf(poolOwnerTreasury.address);
            poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount);
            expect(await mockTokenContract.balanceOf(poolOwnerTreasury.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );

            oldBalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount);
            expect(await mockTokenContract.balanceOf(evaluationAgent.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );
        });

        it("Epoch 4, day 15: Junior lenders request redemption again", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(1_000)], []);
        });

        it("Epoch 4, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            // console.log(`currentTS: ${currentTS}`);

            await juniorTrancheVaultContract.processYieldForLenders();
            await seniorTrancheVaultContract.processYieldForLenders();

            // let epoch = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`junior epoch: ${epoch}`);
            // epoch = await seniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`senior epoch: ${epoch}`);

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(juniorShareRequested),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorShareRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.closeTo(jLenderAmountsProcessed[i], 1);
                }
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorShareRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await seniorTrancheVaultContract.withdrawableAssets(
                            sActiveLenders[i].address,
                        ),
                    ).to.equal(sLenderAmountsProcessed[i]);
                }
            }
            seniorShareRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 5, day 3: Payoff current credit", async function () {
            currentTS = currentTS + 2 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue.add(cr.unbilledPrincipal);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            // cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);

            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 6: Payout yield", async function () {
            currentTS = currentTS + 3 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();
        });

        it("Epoch 5, day 10: The borrower opens a new credit", async function () {
            currentTS = currentTS + 4 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(1_000_000);

            let borowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).drawdown(borrower.address, amount);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesProfits, expectedFirstLossCoverProfits] =
                await pnlCalculator.endRiskAdjustedProfitCalculation(poolProfit);

            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncremnet = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount).add(expectedPoolSafeBalanceIncremnet),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 15: Lenders withdraw processed redemptions", async function () {
            currentTS = currentTS + 5 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = await juniorTrancheVaultContract.withdrawableAssets(
                jActiveLenders[0].address,
            );
            // console.log(`withdrawableAssets: ${amount}`);
            let lenderOldBalance = await mockTokenContract.balanceOf(jActiveLenders[0].address);
            let trancheOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            await juniorTrancheVaultContract.connect(jActiveLenders[0]).disburse();
            expect(await mockTokenContract.balanceOf(jActiveLenders[0].address)).to.equal(
                lenderOldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                trancheOldBalance.sub(amount),
            );
            jLenderWithdrawals[0] = jLenderWithdrawals[0].add(amount);

            amount = await seniorTrancheVaultContract.withdrawableAssets(
                sActiveLenders[0].address,
            );
            lenderOldBalance = await mockTokenContract.balanceOf(sActiveLenders[0].address);
            trancheOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await seniorTrancheVaultContract.connect(sActiveLenders[0]).disburse();
            expect(await mockTokenContract.balanceOf(sActiveLenders[0].address)).to.equal(
                lenderOldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                trancheOldBalance.sub(amount),
            );
            sLenderWithdrawals[0] = sLenderWithdrawals[0].add(amount);
        });

        it("Epoch 5, day after the epoch end date: Process yield, close epoch and no fulfillment of the junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await epochChecker.checkJuniorCurrentEpochEmpty();
            await epochChecker.checkSeniorCurrentEpochEmpty();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorOldShares);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance,
            );

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 6, day 6: Late 1st payment", async function () {
            currentTS = currentTS + 5 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 9, day 1: Default triggered and distribution of profit and loss", async function () {
            /// Epoch 7, day 1
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();
            await creditManagerContract.refreshCredit(borrower.address);

            currentEpochId = currentEpochId.add(1);

            /// Epoch 8, day 1
            cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();
            await creditManagerContract.refreshCredit(borrower.address);

            currentEpochId = currentEpochId.add(1);

            /// Epoch 9, day 1
            cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();

            currentEpochId = currentEpochId.add(1);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditManagerContract.connect(eaServiceAccount).triggerDefault(borrower.address);
            cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let profit = cr.yieldDue.add(dd.yieldPastDue).add(dd.lateFee);
            let loss = cr.nextDue.add(cr.totalPastDue).add(cr.unbilledPrincipal);
            // console.log(`dd: ${dd}`);
            // printCreditRecord("cr", cr);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesLosses, expectedFirstLossCoverLosses] =
                await pnlCalculator.endRiskAdjustedProfitAndLossCalculation(poolProfit, loss);

            // console.log(`expectedTranchesAssets: ${expectedTranchesAssets}`);
            // console.log(`expectedTranchesDeltas: ${expectedTranchesDeltas}`);
            // console.log(`expectedFirstLossCoverDelas: ${expectedFirstLossCoverDelas}`);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            await checkAssetsForLoss(
                expectedTranchesAssets,
                expectedFirstLossCoverLosses,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            // console.log(
            //     `poolSafeOldBalance: ${poolSafeOldBalance}, poolSafeNewBalance: ${await mockTokenContract.balanceOf(
            //         poolSafeContract.address,
            //     )}`,
            // );

            let expectedPoolSafeBalanceIncremnet = expectedFirstLossCoverLosses[
                CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX
            ]
                .add(expectedFirstLossCoverLosses[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX])
                .mul(-1);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(expectedPoolSafeBalanceIncremnet),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 9, day 25: The borrower makes partial payment and distributes loss recovery", async function () {
            currentTS = currentTS + 24 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(800_000);

            let borowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let borrowerFLCOldAssets = await borrowerFirstLossCoverContract.totalAssets();
            let affiliateFLCOldAssets = await affiliateFirstLossCoverContract.totalAssets();
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await creditContract.connect(borrower).makePayment(borrower.address, amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borowerOldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.add(amount),
            );
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                borrowerFLCOldAssets,
            );
            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                affiliateFLCOldAssets,
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(amount),
            );
        });

        it("Epoch 9, day after the epoch end date: Process yield and close epoch and no fulfillment of the junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await epochChecker.checkJuniorCurrentEpochEmpty();
            await epochChecker.checkSeniorCurrentEpochEmpty();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorOldShares);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance,
            );

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 10, day 10: Lenders in both tranches request full redemption", async function () {
            currentTS = currentTS + 9 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].address),
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[1].address),
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[2].address),
                ],
                [
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[0].address),
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[1].address),
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[2].address),
                ],
            );

            // console.log(
            //     `seniorShareRequested: ${seniorShareRequested}, juniorShareRequested: ${juniorShareRequested}`,
            // );
        });

        it("Epoch 10, day after the epoch end date: Close epoch and the fulfillment of the redemption requests", async function () {
            let [, endTime] = await epochManagerContract.currentEpoch();
            currentTS = endTime.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            // console.log(
            //     `jAmountProcessed: ${jAmountProcessed}, juniorShareRequested: ${juniorShareRequested}`,
            // );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(juniorShareRequested),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.closeTo(
                seniorOldAssets.sub(sAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
            ).to.closeTo(seniorOldBalance.add(sAmountProcessed), 1);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
                1,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorShareRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.closeTo(jLenderAmountsProcessed[i].sub(jLenderWithdrawals[i]), 1);
                }
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorShareRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await seniorTrancheVaultContract.withdrawableAssets(
                            sActiveLenders[i].address,
                        ),
                    ).to.closeTo(sLenderAmountsProcessed[i].sub(sLenderWithdrawals[i]), 1);
                }
            }
            seniorShareRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });
    });

    describe("With FixedYieldTranchesPolicy", function () {
        const FIXED_SENIOR_YIELD_IN_BPS = 500;
        let tranchesPolicyContract: FixedSeniorYieldTranchePolicy;
        let tracker: SeniorYieldTracker;

        async function prepare() {
            [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                treasury,
                eaServiceAccount,
                sentinelServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                affiliateFirstLossCoverContract,
                tranchesPolicyContract as unknown,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract as unknown,
                creditDueManagerContract,
                creditManagerContract as unknown,
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "FixedSeniorYieldTranchePolicy",
                defaultDeployer,
                poolOwner,
                "CreditLine",
                "BorrowerLevelCreditManager",
            );

            await configPool({ fixedSeniorYieldInBps: FIXED_SENIOR_YIELD_IN_BPS });
        }

        before(async function () {
            // console.log(
            //     `FixedYieldTranchesPolicy before block.timestamp: ${
            //         (await getLatestBlock()).timestamp
            //     }`,
            // );
            sId = await evmSnapshot();
            await prepare();
        });

        after(async function () {
            if (sId) {
                await evmRevert(sId);
            }
            juniorShareRequested = BN.from(0);
            seniorShareRequested = BN.from(0);
            jLenderPrincipals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderPrincipals = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderShareRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderShareRequests = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderPrincipalRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderPrincipalRequests = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderAmountsProcessed = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderAmountsProcessed = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            jLenderWithdrawals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
            sLenderWithdrawals = Array(NUM_SENIOR_LENDERS).fill(BN.from(0));
            sActiveLenders = [];
            jActiveLenders = [];
            // console.log("FixedYieldTranchesPolicy after");
        });

        it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {
            let block = await getLatestBlock();
            // console.log(`block.timestamp: ${block.timestamp}`);
            currentTS =
                timestampToMoment(block.timestamp, "YYYY-MM-01").add(1, "month").unix() + 300;
            await setNextBlockTimestamp(currentTS);
            await poolContract.connect(poolOwner).enablePool();

            for (let i = 0; i < jLenderInitialAmounts.length; i++) {
                let oldBalance = await mockTokenContract.balanceOf(jLenders[i].address);
                await juniorTrancheVaultContract
                    .connect(jLenders[i])
                    .deposit(toToken(jLenderInitialAmounts[i]), jLenders[i].address);
                expect(await mockTokenContract.balanceOf(jLenders[i].address)).to.equal(
                    oldBalance.sub(toToken(jLenderInitialAmounts[i])),
                );
                expect(
                    await juniorTrancheVaultContract.totalAssetsOf(jLenders[i].address),
                ).to.equal(toToken(jLenderInitialAmounts[i]));
                jLenderPrincipals[i] = toToken(jLenderInitialAmounts[i]);
                jActiveLenders.push(jLenders[i]);
            }

            for (let i = 0; i < sLenderInitialAmounts.length; i++) {
                let oldBalance = await mockTokenContract.balanceOf(sLenders[i].address);
                await seniorTrancheVaultContract
                    .connect(sLenders[i])
                    .deposit(toToken(sLenderInitialAmounts[i]), sLenders[i].address);
                expect(await mockTokenContract.balanceOf(sLenders[i].address)).to.equal(
                    oldBalance.sub(toToken(sLenderInitialAmounts[i])),
                );
                expect(
                    await seniorTrancheVaultContract.totalAssetsOf(sLenders[i].address),
                ).to.equal(toToken(sLenderInitialAmounts[i]));
                sLenderPrincipals[i] = toToken(sLenderInitialAmounts[i]);
                sActiveLenders.push(sLenders[i]);
            }

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.address,
                    toToken(BORROWER_INITIAL_AMOUNT),
                    11,
                    YIELD_IN_BPS,
                    0,
                    0,
                    true,
                );

            let borowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract
                .connect(borrower)
                .drawdown(borrower.address, toToken(BORROWER_INITIAL_AMOUNT));
            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(toToken(BORROWER_INITIAL_AMOUNT));
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            // console.log(
            //     `newTracker.totalAssets: ${newTracker.totalAssets}, newTracker.lastUpdatedDate: ${newTracker.lastUpdatedDate}, newTracker.unpaidYield: ${newTracker.unpaidYield}`,
            // );

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncremnet = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .sub(toToken(BORROWER_INITIAL_AMOUNT))
                    .add(expectedPoolSafeBalanceIncremnet),
            );

            await checkUserAssets(expectedTranchesAssets);

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {
            currentTS += 28 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue;

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 0, day after the epoch end date: Process yield and close epoch", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let oldEpochId = await epochManagerContract.currentEpochId();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(oldEpochId.add(1));
            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 1, day 3: Lenders in both tranches request redemption", async function () {
            currentTS = currentTS + 2 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [toToken(350), toToken(500)],
                [toToken(500), toToken(700)],
            );
        });

        it("Epoch 1, day 10: Senior lenders put in additional redemption requests", async function () {
            currentTS = currentTS + 7 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(370), toToken(680)]);
        });

        it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
            currentTS = currentTS + 15 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue;

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 1, day after the epoch end date: Process yield, close epoch and the fulfillment of the redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                juniorOldShares.sub(juniorShareRequested),
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.sub(jAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance.add(jAmountProcessed),
            );
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                jLenderAmountsProcessed[i] = jAmountProcessed
                    .mul(jLenderShareRequests[i])
                    .div(juniorShareRequested);
                jLenderShareRequests[i] = BN.from(0);
                jLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[i].address),
                ).to.equal(jLenderAmountsProcessed[i]);
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                sLenderAmountsProcessed[i] = sAmountProcessed
                    .mul(sLenderShareRequests[i])
                    .div(seniorShareRequested);
                sLenderShareRequests[i] = BN.from(0);
                sLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sActiveLenders[i].address),
                ).to.equal(sLenderAmountsProcessed[i]);
            }
            seniorShareRequested = BN.from(0);

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 2, day 6: New senior lenders inject liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await seniorTrancheVaultContract
                .connect(sLenders[2])
                .deposit(amount, sLenders[2].address);
            let newTracker = await PnLCalculator.calcLatestSeniorTracker(
                currentTS,
                FIXED_SENIOR_YIELD_IN_BPS,
                tracker,
            );
            newTracker.totalAssets = newTracker.totalAssets.add(amount);
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address)).to.closeTo(
                amount,
                1,
            );
            sLenderPrincipals[2] = amount;
            sActiveLenders.push(sLenders[2]);
        });

        it("Epoch 2, day 10: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {
            currentTS = currentTS + 4 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            await expect(
                seniorTrancheVaultContract
                    .connect(sLenders[2])
                    .deposit(toToken(600_000), sLenders[2].address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "trancheLiquidityCapExceeded",
            );
        });

        it("Epoch 2, day 15: New junior lenders inject liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(30_000);

            let oldBalance = await mockTokenContract.balanceOf(jLenders[2].address);
            await juniorTrancheVaultContract
                .connect(jLenders[2])
                .deposit(amount, jLenders[2].address);
            expect(await mockTokenContract.balanceOf(jLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await juniorTrancheVaultContract.totalAssetsOf(jLenders[2].address)).to.closeTo(
                amount,
                2,
            );
            jLenderPrincipals[2] = amount;
            jActiveLenders.push(jLenders[2]);
        });

        it("Epoch 2, day 20: Senior lenders are now able to inject additional liquidity", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            let oldAssets = await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address);
            await seniorTrancheVaultContract
                .connect(sLenders[2])
                .deposit(amount, sLenders[2].address);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address)).to.closeTo(
                oldAssets.add(amount),
                1,
            );
            sLenderPrincipals[2] = sLenderPrincipals[2].add(amount);
        });

        it("Epoch 2, day after the epoch end date: Close epoch, no fulfillment of the junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await juniorTrancheVaultContract.processYieldForLenders();
            await seniorTrancheVaultContract.processYieldForLenders();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await epochChecker.checkJuniorCurrentEpochEmpty();
            await epochChecker.checkSeniorCurrentEpochEmpty();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorOldShares);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance,
            );

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 3, day 6: Late 3rd payment", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 3, day 10: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {
            currentTS = currentTS + 4 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(70_000)], []);
        });

        it("Epoch 3, day 25: 4th payment by the borrower", async function () {
            currentTS = currentTS + 15 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            let cc = await creditManagerContract.getCreditConfig(creditHash);
            let cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);

            let [, lateFee] = await calcLateFee(
                poolConfigContract,
                calendarContract,
                cc,
                cr,
                dd,
                currentTS,
            );

            let profit = cr.yieldDue.add(dd.yieldPastDue).add(lateFee);
            let payment = cr.nextDue.add(cr.totalPastDue).add(lateFee).sub(dd.lateFee);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);

            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 3, day after the epoch end date: Process yield, close epoch and partial fulfillment of junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            // The remaining requests are blocked by senior: junior ratio.
            let seniorAssets = await seniorTrancheVaultContract.totalAssets();
            let minJuniorAssets = seniorAssets.div(MAX_SENIOR_JUNIOR_RATIO);
            let jAmountProcessed = (await juniorTrancheVaultContract.totalAssets()).sub(
                minJuniorAssets,
            );
            let jShareProcessed =
                await juniorTrancheVaultContract.convertToShares(jAmountProcessed);

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(jShareProcessed),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                jShareProcessed,
                jAmountProcessed,
                1,
            );

            jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
            jLenderShareRequests[0] = juniorShareRequested.sub(jShareProcessed);
            jLenderPrincipalRequests[0] = jLenderPrincipalRequests[0]
                .mul(jLenderShareRequests[0])
                .div(juniorShareRequested);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
            ).to.closeTo(jLenderAmountsProcessed[0], 1);
            juniorShareRequested = jLenderShareRequests[0];

            // console.log(
            //     `jLenderAmountsProcessed[0]: ${jLenderAmountsProcessed[0]}, jLenderShareRequests[0]: ${jLenderShareRequests[0]}, jLenderPrincipalRequests[0]: ${jLenderPrincipalRequests[0]}`,
            // );

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 4, day 2: Senior lenders request redemption", async function () {
            currentTS = currentTS + 1 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(500_000), toToken(100_000)]);
        });

        it("Epoch 4, day 10: Pool admins withdraws fees", async function () {
            currentTS = currentTS + 8 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            // console.log(`currentTS: ${currentTS}`);

            let amount = toToken(100);

            let oldBalance = await mockTokenContract.balanceOf(treasury.address);
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(protocolOwner).withdrawProtocolFee(amount);
            expect(await mockTokenContract.balanceOf(treasury.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );

            oldBalance = await mockTokenContract.balanceOf(poolOwnerTreasury.address);
            poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount);
            expect(await mockTokenContract.balanceOf(poolOwnerTreasury.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );

            oldBalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount);
            expect(await mockTokenContract.balanceOf(evaluationAgent.address)).to.equal(
                oldBalance.add(amount),
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount),
            );
        });

        it("Epoch 4, day 15: Junior lenders request redemption again", async function () {
            currentTS = currentTS + 5 * 24 * 3600;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(1_000)], []);
        });

        it("Epoch 4, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            // console.log(`currentTS: ${currentTS}`);

            await juniorTrancheVaultContract.processYieldForLenders();
            await seniorTrancheVaultContract.processYieldForLenders();

            // let epoch = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`junior epoch: ${epoch}`);
            // epoch = await seniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`senior epoch: ${epoch}`);

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(juniorShareRequested),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
                1,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorShareRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.closeTo(jLenderAmountsProcessed[i], 2);
                }
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorShareRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await seniorTrancheVaultContract.withdrawableAssets(
                            sActiveLenders[i].address,
                        ),
                    ).to.equal(sLenderAmountsProcessed[i]);
                }
            }
            seniorShareRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 5, day 3: Payoff current credit", async function () {
            currentTS = currentTS + 2 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);
            let profit = cr.yieldDue;
            let payment = cr.nextDue.add(cr.unbilledPrincipal);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).makePayment(borrower.address, payment);
            // cr = await creditContract.getCreditRecord(creditHash);
            // printCreditRecord("cr", cr);

            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(payment),
            );
            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(
                        expectedFirstLossCoverProfits[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX],
                    ),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 6: Payout yield", async function () {
            currentTS = currentTS + 3 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();
        });

        it("Epoch 5, day 10: The borrower makes a new credit", async function () {
            currentTS = currentTS + 4 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(1_000_000);

            let borowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).drawdown(borrower.address, amount);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
            // console.log(`expectedTranchesProfits: ${expectedTranchesProfits}`);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncremnet = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount).add(expectedPoolSafeBalanceIncremnet),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 11: Senior lenders request redemption", async function () {
            currentTS = currentTS + 1 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [],
                [toToken(400_000), toToken(250_000), toToken(100_000)],
            );
        });

        it("Epoch 5, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            // console.log(`currentTS: ${currentTS}`);

            await testYieldPayout();

            // let epoch = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`junior epoch: ${epoch}`);
            // epoch = await seniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
            // console.log(`senior epoch: ${epoch}`);

            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorShareRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await seniorTrancheVaultContract.withdrawableAssets(
                            sActiveLenders[i].address,
                        ),
                    ).to.equal(sLenderAmountsProcessed[i]);
                }
            }
            seniorShareRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 6, day 6: Late 1st payment", async function () {
            currentTS = currentTS + 5 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 9, day 1: Default triggered and distribution of profit and loss", async function () {
            /// Epoch 7, day 1
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();
            await creditManagerContract.refreshCredit(borrower.address);

            currentEpochId = currentEpochId.add(1);

            /// Epoch 8, day 1
            cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();
            await creditManagerContract.refreshCredit(borrower.address);

            currentEpochId = currentEpochId.add(1);

            /// Epoch 9, day 1
            cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await epochManagerContract.closeEpoch();

            currentEpochId = currentEpochId.add(1);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let affiliateFLCOldBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditManagerContract.connect(eaServiceAccount).triggerDefault(borrower.address);
            cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let profit = cr.yieldDue.add(dd.yieldPastDue).add(dd.lateFee);
            let loss = cr.nextDue.add(cr.totalPastDue).add(cr.unbilledPrincipal);
            // console.log(`dd: ${dd}`);
            // printCreditRecord("cr", cr);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesLosses,
                expectedFirstLossCoverLosses,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitAndLossCalculation(
                poolProfit,
                tracker,
                loss,
            );

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            // console.log(`expectedTranchesAssets: ${expectedTranchesAssets}`);
            // console.log(`expectedTranchesLosses: ${expectedTranchesLosses}`);
            // console.log(`expectedFirstLossCoverLosses: ${expectedFirstLossCoverLosses}`);

            // console.log(
            //     `junior assets: ${await juniorTrancheVaultContract.totalAssets()}, senior assets: ${await seniorTrancheVaultContract.totalAssets()}`,
            // );

            await checkAssetsForLoss(
                expectedTranchesAssets,
                expectedFirstLossCoverLosses,
                borrowerFLCOldBalance,
                affiliateFLCOldBalance,
            );

            // console.log(
            //     `poolSafeOldBalance: ${poolSafeOldBalance}, poolSafeNewBalance: ${await mockTokenContract.balanceOf(
            //         poolSafeContract.address,
            //     )}`,
            // );

            let expectedPoolSafeBalanceIncremnet = expectedFirstLossCoverLosses[
                CONSTANTS.BORROWER_FIRST_LOSS_COVER_INDEX
            ]
                .add(expectedFirstLossCoverLosses[CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX])
                .mul(-1);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(expectedPoolSafeBalanceIncremnet),
            );

            await checkUserAssets(expectedTranchesAssets);
        });

        it("Epoch 9, day 25: The borrower makes some payment back and distributes loss recovery", async function () {
            currentTS = currentTS + 24 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(800_000);

            let borowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let borrowerFLCOldAssets = await borrowerFirstLossCoverContract.totalAssets();
            let affiliateFLCOldAssets = await affiliateFirstLossCoverContract.totalAssets();
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await creditContract.connect(borrower).makePayment(borrower.address, amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borowerOldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.add(amount),
            );
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                borrowerFLCOldAssets,
            );
            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                affiliateFLCOldAssets,
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(amount),
            );
        });

        it("Epoch 9, day after the epoch end date: Process yield and close epoch and no fulfillment of the junior redemption requests", async function () {
            let cr = await creditContract.getCreditRecord(creditHash);
            currentTS = cr.nextDueDate.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            await epochChecker.checkJuniorCurrentEpochEmpty();
            await epochChecker.checkSeniorCurrentEpochEmpty();
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorOldShares);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance,
            );

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 10, day 10: Lenders in both tranches request full redemption", async function () {
            currentTS = currentTS + 9 * 24 * 3600 + 100;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].address),
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[1].address),
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[2].address),
                ],
                [
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[0].address),
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[1].address),
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[2].address),
                ],
            );

            // console.log(
            //     `seniorShareRequested: ${seniorShareRequested}, juniorShareRequested: ${juniorShareRequested}`,
            // );
        });

        it("Epoch 10, day after the epoch end date: Close epoch and the fulfillment of the redemption requests", async function () {
            let [, endTime] = await epochManagerContract.currentEpoch();
            currentTS = endTime.toNumber() + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            let juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorShareRequested);
            // console.log(
            //     `jAmountProcessed: ${jAmountProcessed}, juniorShareRequested: ${juniorShareRequested}`,
            // );
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorShareRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.closeTo(
                juniorOldShares.sub(juniorShareRequested),
                1,
            );
            expect(jAmountProcessed).to.greaterThan(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorShareRequested,
                juniorShareRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorShareRequested),
            );
            expect(sAmountProcessed).to.greaterThan(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.closeTo(
                seniorOldAssets.sub(sAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
            ).to.closeTo(seniorOldBalance.add(sAmountProcessed), 1);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorShareRequested,
                seniorShareRequested,
                sAmountProcessed,
                1,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorShareRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.closeTo(jLenderAmountsProcessed[i].sub(jLenderWithdrawals[i]), 2);
                }
            }
            juniorShareRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorShareRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await seniorTrancheVaultContract.withdrawableAssets(
                            sActiveLenders[i].address,
                        ),
                    ).to.closeTo(sLenderAmountsProcessed[i].sub(sLenderWithdrawals[i]), 1);
                }
            }
            seniorShareRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });
    });
});
