// For lender integration tests, we will have:
// Epoch period duration is Monthly

import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
    EpochManager,
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
    CreditState,
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
    deployProtocolContracts,
} from "../../BaseTest";
import {
    borrowerLevelCreditHash,
    evmRevert,
    evmSnapshot,
    getLatestBlock,
    getMinLiquidityRequirementForPoolOwner,
    isCloseTo,
    overrideLPConfig,
    setNextBlockTimestamp,
    timestampToMoment,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

// 2 initial lenders (jLender1, jLender2) in the junior tranche;
// 2 initial lenders (sLender1, sLender2) in the senior tranche.
// The number of lenders will change as the test progresses.
// 1 credit line

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    humaTreasury: SignerWithAddress,
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

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: CreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: CreditLineManager;

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
let juniorSharesRequested: BN = BN.from(0),
    seniorSharesRequested: BN = BN.from(0);
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
    const settings = await poolConfigContract.getPoolSettings();
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
            CONSTANTS.BORROWER_LOSS_COVER_INDEX,
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
        .setFirstLossCover(CONSTANTS.ADMIN_LOSS_COVER_INDEX, adminFirstLossCoverContract.address, {
            coverRatePerLossInBps: 1_000,
            coverCapPerLoss: toToken(30_000),
            maxLiquidity: toToken(250_000),
            minLiquidity: 0,
            riskYieldMultiplierInBps: ADMIN_FIRST_LOSS_COVER_RISK_YIELD_MULTIPLIER_IN_BPS,
        });

    await poolConfigContract
        .connect(poolOwner)
        .setPoolOwnerTreasury(poolOwnerTreasury.getAddress());

    await poolConfigContract.connect(poolOwner).setEvaluationAgent(evaluationAgent.getAddress());

    const adminRnR = await poolConfigContract.getAdminRnR();
    await mockTokenContract
        .connect(poolOwnerTreasury)
        .approve(poolSafeContract.address, ethers.constants.MaxUint256);
    await mockTokenContract.mint(poolOwnerTreasury.getAddress(), toToken(1_000_000_000));
    const poolOwnerLiquidity = await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
    await juniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolOwnerLiquidity);
    const poolSettings = await poolConfigContract.getPoolSettings();
    await seniorTrancheVaultContract
        .connect(poolOwnerTreasury)
        .makeInitialDeposit(poolSettings.minDepositAmount);

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
        .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await mockTokenContract
        .connect(evaluationAgent)
        .approve(adminFirstLossCoverContract.address, ethers.constants.MaxUint256);
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(humaTreasury.getAddress());
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(poolOwnerTreasury.getAddress());
    await adminFirstLossCoverContract
        .connect(poolOwner)
        .addCoverProvider(evaluationAgent.getAddress());

    const role = await poolConfigContract.POOL_OPERATOR_ROLE();
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOwner.getAddress());
    await poolConfigContract.connect(poolOwner).grantRole(role, poolOperator.getAddress());

    await juniorTrancheVaultContract
        .connect(poolOperator)
        .addApprovedLender(poolOwnerTreasury.address, true);
    await juniorTrancheVaultContract
        .connect(poolOperator)
        .addApprovedLender(evaluationAgent.address, true);

    // Deposit 1% of the pool liquidity cap as the first loss cover.
    await adminFirstLossCoverContract
        .connect(poolOwnerTreasury)
        .depositCover(POOL_LIQUIDITY_CAP.div(100));
    await adminFirstLossCoverContract
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
        const reinvestYield = (
            await juniorTrancheVaultContract.depositRecords(jLenders[i].address)
        ).reinvestYield;
        if (reinvestYield != jLenderReinvests[i]) {
            await juniorTrancheVaultContract
                .connect(poolOperator)
                .setReinvestYield(jLenders[i].address, jLenderReinvests[i]);
        }
    }
    for (let i = 0; i < sLenders.length; i++) {
        const reinvestYield = (
            await seniorTrancheVaultContract.depositRecords(sLenders[i].address)
        ).reinvestYield;
        if (reinvestYield != sLenderReinvests[i]) {
            await seniorTrancheVaultContract
                .connect(poolOperator)
                .setReinvestYield(sLenders[i].address, sLenderReinvests[i]);
        }
    }

    feeCalculator = new FeeCalculator(humaConfigContract, poolConfigContract);
    pnlCalculator = new ProfitAndLossCalculator(
        poolConfigContract,
        poolContract,
        calendarContract,
        [borrowerFirstLossCoverContract, null, adminFirstLossCoverContract],
    );
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
    adminFLCOldBalance: BN,
) {
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE],
    );
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
    );
    expect(expectedFirstLossCoverProfits[CONSTANTS.BORROWER_LOSS_COVER_INDEX]).to.equal(0);
    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(borrowerFLCOldBalance);
    expect(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]).to.be.gt(0);
    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
        adminFLCOldBalance.add(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
    );
}

async function checkAssetsForLoss(
    expectedTranchesAssets: BN[],
    expectedFirstLossCoverLosses: BN[],
    borrowerFLCOldBalance: BN,
    adminFLCOldBalance: BN,
) {
    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE],
    );
    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
        expectedTranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
    );
    expect(expectedFirstLossCoverLosses[CONSTANTS.BORROWER_LOSS_COVER_INDEX]).to.be.lt(0);
    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
        borrowerFLCOldBalance.add(
            expectedFirstLossCoverLosses[CONSTANTS.BORROWER_LOSS_COVER_INDEX],
        ),
    );
    expect(expectedFirstLossCoverLosses[CONSTANTS.ADMIN_LOSS_COVER_INDEX]).to.be.lt(0);
    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
        adminFLCOldBalance.add(expectedFirstLossCoverLosses[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
    );
}

async function checkLenderAssets(expectedTranchesAssets: BN[]) {
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
                ).to.be.closeTo(jLenderPrincipals[i], 1);
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
                ).to.be.closeTo(sLenderPrincipals[i], 1);
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
            const oldShares = await juniorTrancheVaultContract.balanceOf(jLenders[i].address);
            await juniorTrancheVaultContract
                .connect(jLenders[i])
                .addRedemptionRequest(jLenderRequests[i]);
            expect(await juniorTrancheVaultContract.balanceOf(jLenders[i].address)).to.equal(
                oldShares.sub(jLenderRequests[i]),
            );
            const [newPrincipal] = await juniorTrancheVaultContract.depositRecords(
                jLenders[i].address,
            );
            const principalRequested = jLenderPrincipals[i].mul(jLenderRequests[i]).div(oldShares);
            const expectedNewPrincipal = jLenderPrincipals[i].sub(principalRequested);
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
            ).to.be.closeTo(jLenderShareRequests[i], 1);
            juniorSharesRequested = juniorSharesRequested.add(jLenderRequests[i]);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                BN.from(0),
                BN.from(0),
                1,
            );
        }
    }

    for (let i = 0; i < sLenderRequests.length; i++) {
        if (sLenderRequests[i].gt(0)) {
            const oldShares = await seniorTrancheVaultContract.balanceOf(sLenders[i].address);
            await seniorTrancheVaultContract
                .connect(sLenders[i])
                .addRedemptionRequest(sLenderRequests[i]);
            expect(await seniorTrancheVaultContract.balanceOf(sLenders[i].address)).to.equal(
                oldShares.sub(sLenderRequests[i]),
            );
            const [newPrincipal] = await seniorTrancheVaultContract.depositRecords(
                sLenders[i].address,
            );
            const principalRequested = sLenderPrincipals[i].mul(sLenderRequests[i]).div(oldShares);
            const expectedNewPrincipal = sLenderPrincipals[i].sub(principalRequested);
            expect(newPrincipal).to.be.closeTo(expectedNewPrincipal, 1);
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
            seniorSharesRequested = seniorSharesRequested.add(sLenderRequests[i]);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
            );
        }
    }
}

describe("Multi-tranche Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            humaTreasury,
            evaluationAgent,
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

    after(async function () {
        sLenders = [];
        jLenders = [];
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
            [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                humaTreasury,
                sentinelServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                adminFirstLossCoverContract,
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
                "CreditLineManager",
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
            juniorSharesRequested = BN.from(0);
            seniorSharesRequested = BN.from(0);
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
                    .deposit(toToken(jLenderInitialAmounts[i]));
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
                    .deposit(toToken(sLenderInitialAmounts[i]));
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
                .connect(evaluationAgent)
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).drawdown(toToken(BORROWER_INITIAL_AMOUNT));
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
                adminFLCOldBalance,
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

            await checkLenderAssets(expectedTranchesAssets);

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {
            currentTS += 28 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let cr = await creditContract.getCreditRecord(creditHash);
            let profit = cr.yieldDue;
            let payment = cr.nextDue;

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
            currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [toToken(100), toToken(200)],
                [toToken(300), toToken(300)],
            );
        });

        it("Epoch 1, day 10: Senior lenders put in additional redemption requests", async function () {
            currentTS += 7 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(200), toToken(100)]);
        });

        it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
            currentTS += 15 * CONSTANTS.SECONDS_IN_A_DAY;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                juniorOldShares.sub(juniorSharesRequested),
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.sub(jAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance.add(jAmountProcessed),
            );
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                jLenderAmountsProcessed[i] = jAmountProcessed
                    .mul(jLenderShareRequests[i])
                    .div(juniorSharesRequested);
                jLenderShareRequests[i] = BN.from(0);
                jLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[i].address),
                ).to.equal(jLenderAmountsProcessed[i]);
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                sLenderAmountsProcessed[i] = sAmountProcessed
                    .mul(sLenderShareRequests[i])
                    .div(seniorSharesRequested);
                sLenderShareRequests[i] = BN.from(0);
                sLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sActiveLenders[i].address),
                ).to.equal(sLenderAmountsProcessed[i]);
            }
            seniorSharesRequested = BN.from(0);

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 2, day 6: New senior lenders inject liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            await seniorTrancheVaultContract.connect(sLenders[2]).deposit(amount);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(
                await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address),
            ).to.be.closeTo(amount, 1);
            sLenderPrincipals[2] = amount;
            sActiveLenders.push(sLenders[2]);
        });

        it("Epoch 2, day 10: Senior lenders attempt to inject liquidity, but blocked by senior : junior ratio", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await expect(
                seniorTrancheVaultContract.connect(sLenders[2]).deposit(toToken(600_000)),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "TrancheLiquidityCapExceeded",
            );
        });

        it("Epoch 2, day 15: New junior lenders inject liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(30_000);

            let oldBalance = await mockTokenContract.balanceOf(jLenders[2].address);
            await juniorTrancheVaultContract.connect(jLenders[2]).deposit(amount);
            expect(await mockTokenContract.balanceOf(jLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(
                await juniorTrancheVaultContract.totalAssetsOf(jLenders[2].address),
            ).to.be.closeTo(amount, 2);
            jLenderPrincipals[2] = amount;
            jActiveLenders.push(jLenders[2]);
        });

        it("Epoch 2, day 20: Senior lenders are now able to inject additional liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            let oldAssets = await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address);
            await seniorTrancheVaultContract.connect(sLenders[2]).deposit(amount);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(
                await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address),
            ).to.be.closeTo(oldAssets.add(amount), 1);
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
            await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
            await epochChecker.checkSeniorCurrentRedemptionSummaryEmpty();
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

        it("Epoch 3, day 6: Bill refreshed and the credit is delayed", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 3, day 10: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(150_000)], []);
        });

        it("Epoch 3, day 25: 3rd payment by the borrower", async function () {
            currentTS += 15 * CONSTANTS.SECONDS_IN_A_DAY;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(jShareProcessed),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                jShareProcessed,
                jAmountProcessed,
                1,
            );

            jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
            jLenderShareRequests[0] = juniorSharesRequested.sub(jShareProcessed);
            jLenderPrincipalRequests[0] = jLenderPrincipalRequests[0]
                .mul(jLenderShareRequests[0])
                .div(juniorSharesRequested);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
            ).to.be.closeTo(jLenderAmountsProcessed[0], 1);
            juniorSharesRequested = jLenderShareRequests[0];

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 4, day 2: Senior lenders request redemption", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(200_000), toToken(100_000)]);
        });

        it("Epoch 4, day 10: Pool admins withdraw fees", async function () {
            currentTS += 8 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(100);

            let oldBalance = await mockTokenContract.balanceOf(humaTreasury.address);
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(humaTreasury).withdrawProtocolFee(amount);
            expect(await mockTokenContract.balanceOf(humaTreasury.address)).to.equal(
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
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(1_000)], []);
        });

        it("Epoch 4, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {
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
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(juniorSharesRequested),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorSharesRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.be.closeTo(jLenderAmountsProcessed[i], 1);
                }
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorSharesRequested),
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
            seniorSharesRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 5, day 3: Payoff current credit", async function () {
            currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 6: Payout yield", async function () {
            currentTS += 3 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();
        });

        it("Epoch 5, day 10: The borrower opens a new credit", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(1_000_000);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditContract.connect(borrower).drawdown(amount);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(amount);
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
                adminFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncrement = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount).add(expectedPoolSafeBalanceIncrement),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 15: Lenders withdraw processed redemptions", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = await juniorTrancheVaultContract.withdrawableAssets(
                jActiveLenders[0].address,
            );
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

        it("Epoch 5, day after the epoch end date: Process yield, close epoch and no fulfillment of redemption requests", async function () {
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
            await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
            await epochChecker.checkSeniorCurrentRedemptionSummaryEmpty();
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

        it("Epoch 6, day 6: Bill refreshed and the credit is delayed again", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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

            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            await creditManagerContract.connect(evaluationAgent).triggerDefault(borrower.address);
            cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let profit = cr.yieldDue.add(dd.yieldPastDue).add(dd.lateFee);
            let loss = cr.nextDue.add(cr.totalPastDue).add(cr.unbilledPrincipal);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
                await feeCalculator.calcPoolFeesForProfit(profit);
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [expectedTranchesAssets, expectedTranchesLosses, expectedFirstLossCoverLosses] =
                await pnlCalculator.endRiskAdjustedProfitAndLossCalculation(poolProfit, loss);

            await checkAssetsForLoss(
                expectedTranchesAssets,
                expectedFirstLossCoverLosses,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncrement = expectedFirstLossCoverLosses[
                CONSTANTS.BORROWER_LOSS_COVER_INDEX
            ]
                .add(expectedFirstLossCoverLosses[CONSTANTS.ADMIN_LOSS_COVER_INDEX])
                .mul(-1);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(expectedPoolSafeBalanceIncrement),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 9, day 25: The borrower makes partial payment and loss recovery is distributed", async function () {
            currentTS += 24 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(800_000);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let borrowerFLCOldAssets = await borrowerFirstLossCoverContract.totalAssets();
            let adminFLCOldAssets = await adminFirstLossCoverContract.totalAssets();
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await creditContract.connect(borrower).makePayment(borrower.address, amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.add(amount),
            );
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                borrowerFLCOldAssets,
            );
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(adminFLCOldAssets);
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
            await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
            await epochChecker.checkSeniorCurrentRedemptionSummaryEmpty();
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

        it("Epoch 10, day 10: Some lenders request redemption prior to pool closure", async function () {
            currentTS += 9 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [
                    // First junior lender requests full redemption.
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].address),
                    // Second junior lender requests partial redemption.
                    (await juniorTrancheVaultContract.balanceOf(jActiveLenders[1].address)).div(2),
                    // Third junior lender does not request redemption.
                    BN.from(0),
                ],
                [
                    // First senior lender does not request redemption.
                    BN.from(0),
                    // Second senior lender requests partial redemption.
                    (await seniorTrancheVaultContract.balanceOf(sActiveLenders[1].address)).div(3),
                    // Third senior lender requests full redemption.
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[2].address),
                ],
            );
        });

        it("Epoch 10, day 15: Close pool and process the final redemption requests in the final epoch", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            const juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            const jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            const seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            const seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            const seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            const sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);

            await poolContract.connect(poolOwner).closePool();

            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(juniorSharesRequested),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                seniorOldAssets.sub(sAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
            ).to.be.closeTo(seniorOldBalance.add(sAmountProcessed), 1);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
                1,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorSharesRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                }
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorSharesRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                }
            }
            seniorSharesRequested = BN.from(0);
        });

        it("Epoch 10, day 15: All lenders withdraw their assets", async function () {
            for (const [i, jLender] of jActiveLenders.entries()) {
                const amountDisbursable = jLenderAmountsProcessed[i].sub(jLenderWithdrawals[i]);
                const numShares = await juniorTrancheVaultContract.balanceOf(jLender.getAddress());
                const expectedAssetsWithdrawn =
                    await juniorTrancheVaultContract.convertToAssets(numShares);
                if (i === 0) {
                    // The first junior lender has requested redemption for all their shares.
                    expect(numShares).to.equal(0);
                    expect(expectedAssetsWithdrawn).to.equal(0);
                    expect(amountDisbursable).to.be.gt(0);
                } else if (i === 1) {
                    // The second junior lender has requested partial redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.be.gt(0);
                } else {
                    // The second junior lender didn't request redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.equal(0);
                }
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
                ).to.be.closeTo(amountDisbursable.add(expectedAssetsWithdrawn), 2);

                const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(jLender.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    juniorTrancheVaultContract.address,
                );

                if (i === 0) {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .not.to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn");
                } else if (i === 1) {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn);
                } else {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn)
                        .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");
                }

                expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(jLender.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn).add(amountDisbursable),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance.sub(amountDisbursable), 2);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
                ).to.equal(0);
            }

            for (const [i, sLender] of sActiveLenders.entries()) {
                const amountDisbursable = sLenderAmountsProcessed[i].sub(sLenderWithdrawals[i]);
                const numShares = await seniorTrancheVaultContract.balanceOf(sLender.getAddress());
                const expectedAssetsWithdrawn =
                    await seniorTrancheVaultContract.convertToAssets(numShares);
                if (i === 0) {
                    // The first senior lender didn't request redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.equal(0);
                } else if (i === 1) {
                    // The second senior lender has requested partial redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.be.gt(0);
                } else {
                    // The third senior lender has requested redemption for all their shares.
                    expect(numShares).to.equal(0);
                    expect(expectedAssetsWithdrawn).to.equal(0);
                    expect(amountDisbursable).to.be.gt(0);
                }

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sLender.getAddress()),
                ).to.be.closeTo(amountDisbursable.add(expectedAssetsWithdrawn), 2);

                const oldTotalSupply = await seniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await seniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(sLender.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );

                if (i === 0) {
                    await expect(
                        seniorTrancheVaultContract.connect(sLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(seniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await sLender.getAddress(), numShares, expectedAssetsWithdrawn)
                        .not.to.emit(seniorTrancheVaultContract, "LenderFundDisbursed");
                } else if (i === 1) {
                    await expect(
                        seniorTrancheVaultContract.connect(sLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await sLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .to.emit(seniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await sLender.getAddress(), numShares, expectedAssetsWithdrawn);
                } else {
                    await expect(
                        seniorTrancheVaultContract.connect(sLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await sLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .not.to.emit(seniorTrancheVaultContract, "LenderFundWithdrawn");
                }

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(sLender.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn).add(amountDisbursable),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance.sub(amountDisbursable), 2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sLender.getAddress()),
                ).to.equal(0);
            }
        });

        it("Epoch 10, day 16: The pool owner and EA withdraw their assets from tranches", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;

            // Make sure the pool owner and EA can withdraw assets even if the liquidity requirement is not set to 0.
            const adminRnR = await poolConfigContract.getAdminRnR();
            expect(adminRnR.liquidityRateInBpsByPoolOwner).to.be.gt(0);
            expect(adminRnR.liquidityRateInBpsByEA).to.be.gt(0);

            for (const [i, admin] of [poolOwnerTreasury, evaluationAgent].entries()) {
                const numShares = await juniorTrancheVaultContract.balanceOf(admin.getAddress());
                const expectedAssetsWithdrawn =
                    await juniorTrancheVaultContract.convertToAssets(numShares);

                const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(admin.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    juniorTrancheVaultContract.address,
                );

                await expect(juniorTrancheVaultContract.connect(admin).withdrawAfterPoolClosure())
                    .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                    .withArgs(await admin.getAddress(), numShares, expectedAssetsWithdrawn)
                    .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");

                expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(admin.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance, 2);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(admin.getAddress()),
                ).to.equal(0);
            }

            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
        });

        it("Epoch 10, day 17: All first loss cover providers withdraw their assets", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;

            // Borrower redeems from first loss cover.
            const borrowerShares = await borrowerFirstLossCoverContract.balanceOf(
                borrower.getAddress(),
            );
            const borrowerAssets = await borrowerFirstLossCoverContract.totalAssetsOf(
                borrower.getAddress(),
            );
            const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
            const oldBorrowerFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );

            await borrowerFirstLossCoverContract
                .connect(borrower)
                .redeemCover(borrowerShares, borrower.getAddress());

            expect(await borrowerFirstLossCoverContract.balanceOf(borrower.getAddress())).to.equal(
                0,
            );
            expect(
                await borrowerFirstLossCoverContract.totalAssetsOf(borrower.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(borrower.getAddress())).to.equal(
                oldBorrowerBalance.add(borrowerAssets),
            );
            expect(
                await mockTokenContract.balanceOf(borrowerFirstLossCoverContract.address),
            ).to.equal(oldBorrowerFirstLossCoverContractBalance.sub(borrowerAssets));
            expect(await borrowerFirstLossCoverContract.totalSupply()).to.equal(0);
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);

            // Pool owner treasury redeems from first loss cover.
            const poolOwnerTreasuryShares = await adminFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            const poolOwnerTreasuryAssets = await adminFirstLossCoverContract.totalAssetsOf(
                poolOwnerTreasury.getAddress(),
            );
            const oldPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            let oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );

            await adminFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .redeemCover(poolOwnerTreasuryShares, poolOwnerTreasury.getAddress());

            expect(
                await adminFirstLossCoverContract.balanceOf(poolOwnerTreasury.getAddress()),
            ).to.equal(0);
            expect(
                await adminFirstLossCoverContract.totalAssetsOf(poolOwnerTreasury.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(poolOwnerTreasury.getAddress())).to.equal(
                oldPoolOwnerTreasuryBalance.add(poolOwnerTreasuryAssets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldAdminFirstLossCoverContractBalance.sub(poolOwnerTreasuryAssets));

            // EA redeems from first loss cover.
            const eaShares = await adminFirstLossCoverContract.balanceOf(
                evaluationAgent.getAddress(),
            );
            const eaAssets = await adminFirstLossCoverContract.totalAssetsOf(
                evaluationAgent.getAddress(),
            );
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
            oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );

            await adminFirstLossCoverContract
                .connect(evaluationAgent)
                .redeemCover(eaShares, evaluationAgent.getAddress());

            expect(
                await adminFirstLossCoverContract.balanceOf(evaluationAgent.getAddress()),
            ).to.equal(0);
            expect(
                await adminFirstLossCoverContract.totalAssetsOf(evaluationAgent.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                oldEABalance.add(eaAssets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldAdminFirstLossCoverContractBalance.sub(eaAssets));
            expect(await adminFirstLossCoverContract.totalSupply()).to.equal(0);
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
        });
    });

    describe("With FixedYieldTranchesPolicy", function () {
        const FIXED_SENIOR_YIELD_IN_BPS = 500;
        let tranchesPolicyContract: FixedSeniorYieldTranchePolicy;
        let tracker: SeniorYieldTracker;

        async function prepare() {
            [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                humaTreasury,
                sentinelServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                adminFirstLossCoverContract,
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
                "CreditLineManager",
            );

            await configPool({ fixedSeniorYieldInBps: FIXED_SENIOR_YIELD_IN_BPS });
        }

        before(async function () {
            sId = await evmSnapshot();
            await prepare();
        });

        after(async function () {
            if (sId) {
                await evmRevert(sId);
            }
            juniorSharesRequested = BN.from(0);
            seniorSharesRequested = BN.from(0);
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
                    .deposit(toToken(jLenderInitialAmounts[i]));
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
                    .deposit(toToken(sLenderInitialAmounts[i]));
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
                .connect(evaluationAgent)
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).drawdown(toToken(BORROWER_INITIAL_AMOUNT));
            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(toToken(BORROWER_INITIAL_AMOUNT));
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
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

            await checkLenderAssets(expectedTranchesAssets);

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);
        });

        it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {
            currentTS += 28 * CONSTANTS.SECONDS_IN_A_DAY;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
            currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [toToken(350), toToken(500)],
                [toToken(500), toToken(700)],
            );
        });

        it("Epoch 1, day 10: Senior lenders put in additional redemption requests", async function () {
            currentTS += 7 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(370), toToken(680)]);
        });

        it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
            currentTS += 15 * CONSTANTS.SECONDS_IN_A_DAY;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                juniorOldShares.sub(juniorSharesRequested),
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.sub(jAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
                juniorOldBalance.add(jAmountProcessed),
            );
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                jLenderAmountsProcessed[i] = jAmountProcessed
                    .mul(jLenderShareRequests[i])
                    .div(juniorSharesRequested);
                jLenderShareRequests[i] = BN.from(0);
                jLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[i].address),
                ).to.equal(jLenderAmountsProcessed[i]);
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                sLenderAmountsProcessed[i] = sAmountProcessed
                    .mul(sLenderShareRequests[i])
                    .div(seniorSharesRequested);
                sLenderShareRequests[i] = BN.from(0);
                sLenderPrincipalRequests[i] = BN.from(0);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sActiveLenders[i].address),
                ).to.equal(sLenderAmountsProcessed[i]);
            }
            seniorSharesRequested = BN.from(0);

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 2, day 6: New senior lenders inject liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await seniorTrancheVaultContract.connect(sLenders[2]).deposit(amount);
            let newTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
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
            expect(
                await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address),
            ).to.be.closeTo(amount, 1);
            sLenderPrincipals[2] = amount;
            sActiveLenders.push(sLenders[2]);
        });

        it("Epoch 2, day 10: Senior lenders attempts to inject liquidity, but blocked by senior : junior ratio", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await expect(
                seniorTrancheVaultContract.connect(sLenders[2]).deposit(toToken(600_000)),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "TrancheLiquidityCapExceeded",
            );
        });

        it("Epoch 2, day 15: New junior lenders inject liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(30_000);

            let oldBalance = await mockTokenContract.balanceOf(jLenders[2].address);
            await juniorTrancheVaultContract.connect(jLenders[2]).deposit(amount);
            expect(await mockTokenContract.balanceOf(jLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(
                await juniorTrancheVaultContract.totalAssetsOf(jLenders[2].address),
            ).to.be.closeTo(amount, 2);
            jLenderPrincipals[2] = amount;
            jActiveLenders.push(jLenders[2]);
        });

        it("Epoch 2, day 20: Senior lenders are now able to inject additional liquidity", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(600_000);

            let oldBalance = await mockTokenContract.balanceOf(sLenders[2].address);
            let oldAssets = await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address);
            await seniorTrancheVaultContract.connect(sLenders[2]).deposit(amount);
            expect(await mockTokenContract.balanceOf(sLenders[2].address)).to.equal(
                oldBalance.sub(amount),
            );
            expect(
                await seniorTrancheVaultContract.totalAssetsOf(sLenders[2].address),
            ).to.be.closeTo(oldAssets.add(amount), 1);
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
            await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
            await epochChecker.checkSeniorCurrentRedemptionSummaryEmpty();
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

        it("Epoch 3, day 6: Bill refreshed and the credit is delayed", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await creditManagerContract.refreshCredit(borrower.address);
            const cr = await creditContract.getCreditRecord(creditHash);
            expect(cr.state).to.equal(CreditState.Delayed);
        });

        it("Epoch 3, day 10: Junior lenders put in redemption requests that would breach senior : junior ratio", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(70_000)], []);
        });

        it("Epoch 3, day 25: 3rd payment by the borrower", async function () {
            currentTS += 15 * CONSTANTS.SECONDS_IN_A_DAY;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
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
            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(jShareProcessed),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                jShareProcessed,
                jAmountProcessed,
                1,
            );

            jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
            jLenderShareRequests[0] = juniorSharesRequested.sub(jShareProcessed);
            jLenderPrincipalRequests[0] = jLenderPrincipalRequests[0]
                .mul(jLenderShareRequests[0])
                .div(juniorSharesRequested);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
            ).to.be.closeTo(jLenderAmountsProcessed[0], 1);
            juniorSharesRequested = jLenderShareRequests[0];

            await creditManagerContract.refreshCredit(borrower.address);
            expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
                newEndTime,
            );
            currentEpochId = newEpochId;
        });

        it("Epoch 4, day 2: Senior lenders request redemption", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([], [toToken(500_000), toToken(100_000)]);
        });

        it("Epoch 4, day 10: Pool admins withdraw fees", async function () {
            currentTS += 8 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(100);

            let oldBalance = await mockTokenContract.balanceOf(humaTreasury.address);
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolFeeManagerContract.connect(humaTreasury).withdrawProtocolFee(amount);
            expect(await mockTokenContract.balanceOf(humaTreasury.address)).to.equal(
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
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest([toToken(1_000)], []);
        });

        it("Epoch 4, day after the epoch end date: Close epoch and complete fulfillment of all redemption requests", async function () {
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
            let jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(juniorSharesRequested),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
                1,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorSharesRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                    expect(
                        await juniorTrancheVaultContract.withdrawableAssets(
                            jActiveLenders[i].address,
                        ),
                    ).to.be.closeTo(jLenderAmountsProcessed[i], 2);
                }
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorSharesRequested),
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
            seniorSharesRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 5, day 3: Payoff current credit", async function () {
            currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
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

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance
                    .add(payment)
                    .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 6: Payout yield", async function () {
            currentTS += 3 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();
        });

        it("Epoch 5, day 10: The borrower makes a new credit", async function () {
            currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(1_000_000);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditContract.connect(borrower).drawdown(amount);

            let [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
                await feeCalculator.calcPoolFeesForDrawdown(amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.add(amountToBorrower),
            );
            await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

            let [
                expectedTranchesAssets,
                expectedTranchesProfits,
                expectedFirstLossCoverProfits,
                newTracker,
            ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);

            await checkAssetsForProfit(
                expectedTranchesAssets,
                expectedFirstLossCoverProfits,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncrement = protocolReward
                .add(poolOwnerReward)
                .add(eaReward)
                .add(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE])
                .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.sub(amount).add(expectedPoolSafeBalanceIncrement),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 5, day 11: Senior lenders request redemption", async function () {
            currentTS += 1 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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

            await testYieldPayout();

            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            let seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            let sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);
            await epochManagerContract.closeEpoch();
            let [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
            expect(newEpochId).to.equal(currentEpochId.add(1));
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                seniorOldAssets.sub(sAmountProcessed),
            );
            expect(await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)).to.equal(
                seniorOldBalance.add(sAmountProcessed),
            );
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
            );

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorSharesRequested),
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
            seniorSharesRequested = BN.from(0);

            let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01")
                .add(1, "month")
                .unix();
            expect(newEndTime).to.equal(expectedEndTime);
            currentEpochId = newEpochId;
        });

        it("Epoch 6, day 6: Bill refreshed and the credit is delayed again", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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

            let oldFees = await poolFeeManagerContract.getAccruedIncomes();
            let borrowerFLCOldBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );
            let adminFLCOldBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await pnlCalculator.beginProfitCalculation();
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            await creditManagerContract.connect(evaluationAgent).triggerDefault(borrower.address);
            cr = await creditContract.getCreditRecord(creditHash);
            let dd = await creditContract.getDueDetail(creditHash);
            let profit = cr.yieldDue.add(dd.yieldPastDue).add(dd.lateFee);
            let loss = cr.nextDue.add(cr.totalPastDue).add(cr.unbilledPrincipal);

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

            await checkAssetsForLoss(
                expectedTranchesAssets,
                expectedFirstLossCoverLosses,
                borrowerFLCOldBalance,
                adminFLCOldBalance,
            );

            let expectedPoolSafeBalanceIncrement = expectedFirstLossCoverLosses[
                CONSTANTS.BORROWER_LOSS_COVER_INDEX
            ]
                .add(expectedFirstLossCoverLosses[CONSTANTS.ADMIN_LOSS_COVER_INDEX])
                .mul(-1);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(expectedPoolSafeBalanceIncrement),
            );

            await checkLenderAssets(expectedTranchesAssets);
        });

        it("Epoch 9, day 25: The borrower makes some payment back and loss recovery is distributed", async function () {
            currentTS += 24 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            let amount = toToken(800_000);

            let borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
            let seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            let juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            let borrowerFLCOldAssets = await borrowerFirstLossCoverContract.totalAssets();
            let adminFLCOldAssets = await adminFirstLossCoverContract.totalAssets();
            let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await creditContract.connect(borrower).makePayment(borrower.address, amount);
            expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
                borrowerOldBalance.sub(amount),
            );
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorOldAssets);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                juniorOldAssets.add(amount),
            );
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                borrowerFLCOldAssets,
            );
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(adminFLCOldAssets);
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                poolSafeOldBalance.add(amount),
            );
        });

        it("Epoch 9, day after the epoch end date: Process yield and close epoch and no fulfillment of redemption requests", async function () {
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
            await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
            await epochChecker.checkSeniorCurrentRedemptionSummaryEmpty();

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

        it("Epoch 10, day 10: Some lenders request redemption prior to pool closure", async function () {
            currentTS += 9 * CONSTANTS.SECONDS_IN_A_DAY + 100;
            await setNextBlockTimestamp(currentTS);

            await testRedemptionRequest(
                [
                    // First junior lender requests full redemption.
                    await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].address),
                    // Second junior lender requests partial redemption.
                    (await juniorTrancheVaultContract.balanceOf(jActiveLenders[1].address)).div(2),
                    // Third junior lender does not request redemption.
                    BN.from(0),
                ],
                [
                    // First senior lender does not request redemption.
                    BN.from(0),
                    // Second senior lender requests partial redemption.
                    (await seniorTrancheVaultContract.balanceOf(sActiveLenders[1].address)).div(3),
                    // Third senior lender requests full redemption.
                    await seniorTrancheVaultContract.balanceOf(sActiveLenders[2].address),
                ],
            );
        });

        it("Epoch 10, day 15: Close pool and process the final redemption requests in the final epoch", async function () {
            currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(currentTS);

            await testYieldPayout();

            const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
            const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
            const juniorOldBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );
            const jAmountProcessed =
                await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
            const seniorOldAssets = await seniorTrancheVaultContract.totalAssets();
            const seniorOldShares = await seniorTrancheVaultContract.totalSupply();
            const seniorOldBalance = await mockTokenContract.balanceOf(
                seniorTrancheVaultContract.address,
            );
            const sAmountProcessed =
                await seniorTrancheVaultContract.convertToAssets(seniorSharesRequested);

            await poolContract.connect(poolOwner).closePool();

            expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                juniorOldShares.sub(juniorSharesRequested),
                1,
            );
            expect(jAmountProcessed).to.be.gt(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                juniorOldAssets.sub(jAmountProcessed),
                2,
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
            await epochChecker.checkJuniorRedemptionSummaryById(
                currentEpochId,
                juniorSharesRequested,
                juniorSharesRequested,
                jAmountProcessed,
                2,
            );
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                seniorOldShares.sub(seniorSharesRequested),
            );
            expect(sAmountProcessed).to.be.gt(0);
            expect(await seniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                seniorOldAssets.sub(sAmountProcessed),
                1,
            );
            expect(
                await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
            ).to.be.closeTo(seniorOldBalance.add(sAmountProcessed), 1);
            await epochChecker.checkSeniorRedemptionSummaryById(
                currentEpochId,
                seniorSharesRequested,
                seniorSharesRequested,
                sAmountProcessed,
                1,
            );

            for (let i = 0; i < jActiveLenders.length; i++) {
                if (jLenderShareRequests[i].gt(0)) {
                    jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                        jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorSharesRequested),
                    );
                    jLenderShareRequests[i] = BN.from(0);
                    jLenderPrincipalRequests[i] = BN.from(0);
                }
            }
            juniorSharesRequested = BN.from(0);

            for (let i = 0; i < sActiveLenders.length; i++) {
                if (sLenderShareRequests[i].gt(0)) {
                    sLenderAmountsProcessed[i] = sLenderAmountsProcessed[i].add(
                        sAmountProcessed.mul(sLenderShareRequests[i]).div(seniorSharesRequested),
                    );
                    sLenderShareRequests[i] = BN.from(0);
                    sLenderPrincipalRequests[i] = BN.from(0);
                }
            }
            seniorSharesRequested = BN.from(0);
        });

        it("Epoch 10, day 15: All lenders withdraw their assets", async function () {
            for (const [i, jLender] of jActiveLenders.entries()) {
                const amountDisbursable = jLenderAmountsProcessed[i].sub(jLenderWithdrawals[i]);
                const numShares = await juniorTrancheVaultContract.balanceOf(jLender.getAddress());
                const expectedAssetsWithdrawn =
                    await juniorTrancheVaultContract.convertToAssets(numShares);
                if (i === 0) {
                    // The first junior lender has requested redemption for all their shares.
                    expect(numShares).to.equal(0);
                    expect(expectedAssetsWithdrawn).to.equal(0);
                    expect(amountDisbursable).to.be.gt(0);
                } else if (i === 1) {
                    // The second junior lender has requested partial redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.be.gt(0);
                } else {
                    // The second junior lender didn't request redemption.
                    expect(numShares).to.be.gt(0);
                    expect(expectedAssetsWithdrawn).to.be.gt(0);
                    expect(amountDisbursable).to.equal(0);
                }
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
                ).to.be.closeTo(amountDisbursable.add(expectedAssetsWithdrawn), 2);

                const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(jLender.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    juniorTrancheVaultContract.address,
                );

                if (i === 0) {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .not.to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn");
                } else if (i === 1) {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn);
                } else {
                    await expect(
                        juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn)
                        .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");
                }

                expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(jLender.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn).add(amountDisbursable),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance.sub(amountDisbursable), 2);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
                ).to.equal(0);
            }

            for (const [i, sLender] of sActiveLenders.entries()) {
                const amountDisbursable = sLenderAmountsProcessed[i].sub(sLenderWithdrawals[i]);
                // All lenders have undisbursed funds from previous epochs.
                expect(amountDisbursable).to.be.gt(0);
                const numShares = await seniorTrancheVaultContract.balanceOf(sLender.getAddress());
                const expectedAssetsWithdrawn =
                    await seniorTrancheVaultContract.convertToAssets(numShares);
                if (i === 2) {
                    // The third senior lender has requested redemption for all their shares.
                    expect(numShares).to.equal(0);
                    expect(expectedAssetsWithdrawn).to.equal(0);
                }

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sLender.getAddress()),
                ).to.be.closeTo(amountDisbursable.add(expectedAssetsWithdrawn), 2);

                const oldTotalSupply = await seniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await seniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(sLender.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );

                if (i === 2) {
                    await expect(
                        seniorTrancheVaultContract.connect(sLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await sLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .not.to.emit(seniorTrancheVaultContract, "LenderFundWithdrawn");
                } else {
                    await expect(
                        seniorTrancheVaultContract.connect(sLender).withdrawAfterPoolClosure(),
                    )
                        .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                        .withArgs(await sLender.getAddress(), (actualAmountDisbursed: BN) =>
                            isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                        )
                        .to.emit(seniorTrancheVaultContract, "LenderFundWithdrawn")
                        .withArgs(await sLender.getAddress(), numShares, expectedAssetsWithdrawn);
                }

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(sLender.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn).add(amountDisbursable),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance.sub(amountDisbursable), 2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(sLender.getAddress()),
                ).to.equal(0);
            }
        });

        it("Epoch 10, day 16: The pool owner and EA withdraw their assets from tranches", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;

            // Make sure the pool owner and EA can withdraw assets even if the liquidity requirement is not set to 0.
            const adminRnR = await poolConfigContract.getAdminRnR();
            expect(adminRnR.liquidityRateInBpsByPoolOwner).to.be.gt(0);
            expect(adminRnR.liquidityRateInBpsByEA).to.be.gt(0);

            for (const [i, admin] of [poolOwnerTreasury, evaluationAgent].entries()) {
                const numShares = await juniorTrancheVaultContract.balanceOf(admin.getAddress());
                const expectedAssetsWithdrawn =
                    await juniorTrancheVaultContract.convertToAssets(numShares);

                const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
                const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
                const oldLenderBalance = await mockTokenContract.balanceOf(admin.getAddress());
                const oldPoolSafeBalance = await mockTokenContract.balanceOf(
                    poolSafeContract.address,
                );
                const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                    juniorTrancheVaultContract.address,
                );

                await expect(juniorTrancheVaultContract.connect(admin).withdrawAfterPoolClosure())
                    .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                    .withArgs(await admin.getAddress(), numShares, expectedAssetsWithdrawn)
                    .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");

                expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                    oldTotalSupply.sub(numShares),
                );
                expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                    oldTotalAssets.sub(expectedAssetsWithdrawn),
                );
                expect(await mockTokenContract.balanceOf(admin.getAddress())).to.be.closeTo(
                    oldLenderBalance.add(expectedAssetsWithdrawn),
                    2,
                );
                expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                    oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
                );
                expect(
                    await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
                ).to.be.closeTo(oldJuniorTrancheBalance, 2);
                expect(
                    await juniorTrancheVaultContract.withdrawableAssets(admin.getAddress()),
                ).to.equal(0);
            }

            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
        });

        it("Epoch 10, day 16: All first loss cover providers withdraw their assets", async function () {
            currentTS += CONSTANTS.SECONDS_IN_A_DAY;

            // Borrower redeems from first loss cover.
            const borrowerShares = await borrowerFirstLossCoverContract.balanceOf(
                borrower.getAddress(),
            );
            const borrowerAssets = await borrowerFirstLossCoverContract.totalAssetsOf(
                borrower.getAddress(),
            );
            const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
            const oldBorrowerFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                borrowerFirstLossCoverContract.address,
            );

            await borrowerFirstLossCoverContract
                .connect(borrower)
                .redeemCover(borrowerShares, borrower.getAddress());

            expect(await borrowerFirstLossCoverContract.balanceOf(borrower.getAddress())).to.equal(
                0,
            );
            expect(
                await borrowerFirstLossCoverContract.totalAssetsOf(borrower.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(borrower.getAddress())).to.equal(
                oldBorrowerBalance.add(borrowerAssets),
            );
            expect(
                await mockTokenContract.balanceOf(borrowerFirstLossCoverContract.address),
            ).to.equal(oldBorrowerFirstLossCoverContractBalance.sub(borrowerAssets));
            expect(await borrowerFirstLossCoverContract.totalSupply()).to.equal(0);
            expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);

            // Pool owner treasury redeems from first loss cover.
            const poolOwnerTreasuryShares = await adminFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            const poolOwnerTreasuryAssets = await adminFirstLossCoverContract.totalAssetsOf(
                poolOwnerTreasury.getAddress(),
            );
            const oldPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            let oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );

            await adminFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .redeemCover(poolOwnerTreasuryShares, poolOwnerTreasury.getAddress());

            expect(
                await adminFirstLossCoverContract.balanceOf(poolOwnerTreasury.getAddress()),
            ).to.equal(0);
            expect(
                await adminFirstLossCoverContract.totalAssetsOf(poolOwnerTreasury.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(poolOwnerTreasury.getAddress())).to.equal(
                oldPoolOwnerTreasuryBalance.add(poolOwnerTreasuryAssets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldAdminFirstLossCoverContractBalance.sub(poolOwnerTreasuryAssets));

            // EA redeems from first loss cover.
            const eaShares = await adminFirstLossCoverContract.balanceOf(
                evaluationAgent.getAddress(),
            );
            const eaAssets = await adminFirstLossCoverContract.totalAssetsOf(
                evaluationAgent.getAddress(),
            );
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
            oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );

            await adminFirstLossCoverContract
                .connect(evaluationAgent)
                .redeemCover(eaShares, evaluationAgent.getAddress());

            expect(
                await adminFirstLossCoverContract.balanceOf(evaluationAgent.getAddress()),
            ).to.equal(0);
            expect(
                await adminFirstLossCoverContract.totalAssetsOf(evaluationAgent.getAddress()),
            ).to.equal(0);
            expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                oldEABalance.add(eaAssets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldAdminFirstLossCoverContractBalance.sub(eaAssets));
            expect(await adminFirstLossCoverContract.totalSupply()).to.equal(0);
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
        });
    });
});

describe("Uni-tranche Test", function () {
    const JLENDER1_INITIAL_AMOUNT = 1_200_000;
    const JLENDER2_INITIAL_AMOUNT = 800_000;
    const BORROWER_INITIAL_AMOUNT = 2_000_000;

    let sId: unknown;
    const jLenderInitialAmounts = [JLENDER1_INITIAL_AMOUNT, JLENDER2_INITIAL_AMOUNT];
    let tranchesPolicyContract: FixedSeniorYieldTranchePolicy;
    let tracker: SeniorYieldTracker;

    async function prepare() {
        [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            humaTreasury,
            sentinelServiceAccount,
            poolOwner,
        );

        [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            adminFirstLossCoverContract,
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
            "CreditLineManager",
        );

        await configPool({ fixedSeniorYieldInBps: 0, maxSeniorJuniorRatio: 0 });
    }

    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            humaTreasury,
            evaluationAgent,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            jLenders[0],
            jLenders[1],
            jLenders[2],
            borrower,
        ] = await ethers.getSigners();

        sId = await evmSnapshot();
        await prepare();
    });

    after(async function () {
        if (sId) {
            await evmRevert(sId);
        }
        juniorSharesRequested = BN.from(0);
        jLenderPrincipals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
        jLenderShareRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
        jLenderPrincipalRequests = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
        jLenderAmountsProcessed = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
        jLenderWithdrawals = Array(NUM_JUNIOR_LENDERS).fill(BN.from(0));
        jLenders = [];
        jActiveLenders = [];
    });

    it("Epoch 0, day 0: Lenders provide liquidity and the borrower makes initial drawdown", async function () {
        let block = await getLatestBlock();
        currentTS = timestampToMoment(block.timestamp, "YYYY-MM-01").add(1, "month").unix() + 300;
        await setNextBlockTimestamp(currentTS);
        await poolContract.connect(poolOwner).enablePool();

        for (let i = 0; i < jLenderInitialAmounts.length; i++) {
            const oldBalance = await mockTokenContract.balanceOf(jLenders[i].address);
            await juniorTrancheVaultContract
                .connect(jLenders[i])
                .deposit(toToken(jLenderInitialAmounts[i]));
            expect(await mockTokenContract.balanceOf(jLenders[i].address)).to.equal(
                oldBalance.sub(toToken(jLenderInitialAmounts[i])),
            );
            expect(await juniorTrancheVaultContract.totalAssetsOf(jLenders[i].address)).to.equal(
                toToken(jLenderInitialAmounts[i]),
            );
            jLenderPrincipals[i] = toToken(jLenderInitialAmounts[i]);
            jActiveLenders.push(jLenders[i]);
        }

        await creditManagerContract
            .connect(evaluationAgent)
            .approveBorrower(
                borrower.address,
                toToken(BORROWER_INITIAL_AMOUNT),
                11,
                YIELD_IN_BPS,
                0,
                0,
                true,
            );

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).drawdown(toToken(BORROWER_INITIAL_AMOUNT));
        const [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
            await feeCalculator.calcPoolFeesForDrawdown(toToken(BORROWER_INITIAL_AMOUNT));
        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.add(amountToBorrower),
        );
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        const expectedPoolSafeBalanceIncrement = protocolReward
            .add(poolOwnerReward)
            .add(eaReward)
            .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance
                .sub(toToken(BORROWER_INITIAL_AMOUNT))
                .add(expectedPoolSafeBalanceIncrement),
        );

        await checkLenderAssets(expectedTranchesAssets);

        creditHash = await borrowerLevelCreditHash(creditContract, borrower);
    });

    it("Epoch 0, day 28: 1st payment by the borrower and distribution of profit", async function () {
        currentTS += 28 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        const cr = await creditContract.getCreditRecord(creditHash);
        const profit = cr.yieldDue;
        const payment = cr.nextDue;

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).makePayment(borrower.address, payment);
        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.sub(payment),
        );
        const [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
            await feeCalculator.calcPoolFeesForProfit(profit);
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance
                .add(payment)
                .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 0, day after the epoch end date: Process yield and close epoch", async function () {
        const cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const oldEpochId = await epochManagerContract.currentEpochId();
        await epochManagerContract.closeEpoch();
        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(oldEpochId.add(1));
        await creditManagerContract.refreshCredit(borrower.address);
        expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
            newEndTime,
        );
        currentEpochId = newEpochId;
    });

    it("Epoch 1, day 3: Lenders request redemption", async function () {
        currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await testRedemptionRequest([toToken(350), toToken(500)], []);
    });

    it("Epoch 1, day 25: 2nd payment by the borrower", async function () {
        currentTS += 22 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        const cr = await creditContract.getCreditRecord(creditHash);
        const profit = cr.yieldDue;
        const payment = cr.nextDue;

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).makePayment(borrower.address, payment);
        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.sub(payment),
        );
        const [protocolReward, poolOwnerReward, eaReward, poolProfit] =
            await feeCalculator.calcPoolFeesForProfit(profit);
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance
                .add(payment)
                .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 1, day after the epoch end date: Process yield, close epoch and complete fulfillment of the redemption requests", async function () {
        const cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        const jAmountProcessed =
            await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
        await epochManagerContract.closeEpoch();
        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
            juniorOldShares.sub(juniorSharesRequested),
        );
        expect(jAmountProcessed).to.be.gt(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorOldAssets.sub(jAmountProcessed),
        );
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorOldBalance.add(jAmountProcessed),
        );
        await epochChecker.checkJuniorRedemptionSummaryById(
            currentEpochId,
            juniorSharesRequested,
            juniorSharesRequested,
            jAmountProcessed,
        );

        for (let i = 0; i < jActiveLenders.length; i++) {
            jLenderAmountsProcessed[i] = jAmountProcessed
                .mul(jLenderShareRequests[i])
                .div(juniorSharesRequested);
            jLenderShareRequests[i] = BN.from(0);
            jLenderPrincipalRequests[i] = BN.from(0);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[i].address),
            ).to.equal(jLenderAmountsProcessed[i]);
        }
        juniorSharesRequested = BN.from(0);

        await creditManagerContract.refreshCredit(borrower.address);
        expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
            newEndTime,
        );
        currentEpochId = newEpochId;
    });

    it("Epoch 2, day 15: New lenders inject liquidity", async function () {
        currentTS += 14 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        const amount = toToken(30_000);

        const oldBalance = await mockTokenContract.balanceOf(jLenders[2].address);
        await juniorTrancheVaultContract.connect(jLenders[2]).deposit(amount);
        expect(await mockTokenContract.balanceOf(jLenders[2].address)).to.equal(
            oldBalance.sub(amount),
        );
        expect(await juniorTrancheVaultContract.totalAssetsOf(jLenders[2].address)).to.be.closeTo(
            amount,
            2,
        );
        jLenderPrincipals[2] = amount;
        jActiveLenders.push(jLenders[2]);
    });

    it("Epoch 2, day after the epoch end date: Close epoch, no fulfillment of the redemption requests", async function () {
        const cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await juniorTrancheVaultContract.processYieldForLenders();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();
        await epochManagerContract.closeEpoch();
        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorOldBalance,
        );

        const expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01").add(1, "month").unix();
        expect(newEndTime).to.equal(expectedEndTime);
        currentEpochId = newEpochId;
    });

    it("Epoch 3, day 6: No payment from the borrower on late payment deadline", async function () {
        currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await creditManagerContract.refreshCredit(borrower.address);
        const cr = await creditContract.getCreditRecord(creditHash);
        expect(cr.state).to.equal(CreditState.Delayed);
    });

    it("Epoch 3, day 10: Junior lenders request redemption", async function () {
        currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await testRedemptionRequest(
            [await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].getAddress())],
            [],
        );
    });

    it("Epoch 3, day 25: 3rd payment by the borrower", async function () {
        currentTS += 15 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        const cc = await creditManagerContract.getCreditConfig(creditHash);
        const cr = await creditContract.getCreditRecord(creditHash);
        const dd = await creditContract.getDueDetail(creditHash);

        const [, lateFee] = await calcLateFee(
            poolConfigContract,
            calendarContract,
            cc,
            cr,
            dd,
            currentTS,
        );

        const profit = cr.yieldDue.add(dd.yieldPastDue).add(lateFee);
        const payment = cr.nextDue.add(cr.totalPastDue).add(lateFee).sub(dd.lateFee);

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).makePayment(borrower.address, payment);

        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.sub(payment),
        );
        const [protocolReward, poolOwnerReward, eaReward, poolProfit] =
            await feeCalculator.calcPoolFeesForProfit(profit);
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance
                .add(payment)
                .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 3, day after the epoch end date: Process yield, close epoch and partial fulfillment of redemption requests", async function () {
        const cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const jAmountRequested =
            await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
        const jAmountProcessed = await poolSafeContract.getAvailableBalanceForPool();
        expect(jAmountRequested).to.be.gt(jAmountProcessed);
        const jShareProcessed = await juniorTrancheVaultContract.convertToShares(jAmountProcessed);

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        await epochManagerContract.closeEpoch();
        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
            juniorOldShares.sub(jShareProcessed),
            1,
        );
        expect(jAmountProcessed).to.be.gt(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
            juniorOldAssets.sub(jAmountProcessed),
            1,
        );
        expect(
            await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
        ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
        await epochChecker.checkJuniorRedemptionSummaryById(
            currentEpochId,
            juniorSharesRequested,
            jShareProcessed,
            jAmountProcessed,
            1,
        );

        jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
        jLenderShareRequests[0] = juniorSharesRequested.sub(jShareProcessed);
        jLenderPrincipalRequests[0] = jLenderPrincipalRequests[0]
            .mul(jLenderShareRequests[0])
            .div(juniorSharesRequested);
        expect(
            await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
        ).to.be.closeTo(jLenderAmountsProcessed[0], 1);
        juniorSharesRequested = jLenderShareRequests[0];

        await creditManagerContract.refreshCredit(borrower.address);
        expect((await creditContract.getCreditRecord(creditHash)).nextDueDate).to.equal(
            newEndTime,
        );
        currentEpochId = newEpochId;

        // Cancel all remaining redemption requests.
        const cancellableShares = await juniorTrancheVaultContract.cancellableRedemptionShares(
            jActiveLenders[0].getAddress(),
        );

        await juniorTrancheVaultContract
            .connect(jActiveLenders[0])
            .cancelRedemptionRequest(cancellableShares);

        expect(
            await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].getAddress()),
        ).to.equal(cancellableShares);
        const [newPrincipal] = await juniorTrancheVaultContract.depositRecords(
            jActiveLenders[0].getAddress(),
        );
        const expectedNewPrincipal = jLenderPrincipals[0].add(jLenderPrincipalRequests[0]);
        expect(newPrincipal).to.be.closeTo(expectedNewPrincipal, 1);
        jLenderShareRequests[0] = BN.from(0);
        jLenderPrincipalRequests[0] = BN.from(0);
        jLenderPrincipals[0] = newPrincipal;
        await checkRedemptionRecordByLender(
            juniorTrancheVaultContract,
            jLenders[0],
            currentEpochId,
            jLenderShareRequests[0],
            jLenderPrincipalRequests[0],
            jLenderAmountsProcessed[0],
            jLenderWithdrawals[0],
            1,
        );
        juniorSharesRequested = juniorSharesRequested.sub(cancellableShares);
    });

    it("Epoch 4, day 10: Invest fees in first loss cover and pool admins withdraw fees", async function () {
        currentTS += 9 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await poolFeeManagerContract.connect(poolOwner).investFeesInFirstLossCover();

        const amount = toToken(100);

        let oldBalance = await mockTokenContract.balanceOf(humaTreasury.address);
        let poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await poolFeeManagerContract.connect(humaTreasury).withdrawProtocolFee(amount);
        expect(await mockTokenContract.balanceOf(humaTreasury.address)).to.equal(
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
        currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await testRedemptionRequest([toToken(1_000)], []);
    });

    it("Epoch 4, day after the epoch end date: Close epoch and no fulfillment of all redemption requests", async function () {
        let cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await juniorTrancheVaultContract.processYieldForLenders();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        await epochManagerContract.closeEpoch();

        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorOldBalance,
        );
        await epochChecker.checkJuniorRedemptionSummaryById(
            currentEpochId,
            juniorSharesRequested,
            BN.from(0),
            BN.from(0),
            1,
        );

        expect(
            await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
        ).to.equal(jLenderAmountsProcessed[0]);

        const expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01").add(1, "month").unix();
        expect(newEndTime).to.equal(expectedEndTime);
        currentEpochId = newEpochId;
    });

    it("Epoch 5, day 3: Payoff current credit", async function () {
        currentTS += 2 * CONSTANTS.SECONDS_IN_A_DAY + 100;
        await setNextBlockTimestamp(currentTS);

        const cr = await creditContract.getCreditRecord(creditHash);
        const profit = cr.yieldDue;
        const payment = cr.nextDue.add(cr.unbilledPrincipal);

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).makePayment(borrower.address, payment);

        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.sub(payment),
        );
        let [protocolReward, poolOwnerReward, eaReward, poolProfit] =
            await feeCalculator.calcPoolFeesForProfit(profit);
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance
                .add(payment)
                .sub(expectedFirstLossCoverProfits[CONSTANTS.ADMIN_LOSS_COVER_INDEX]),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 5, day 6: Payout yield", async function () {
        currentTS += 3 * CONSTANTS.SECONDS_IN_A_DAY + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();
    });

    it("Epoch 5, day 10: The borrower requests a new credit", async function () {
        currentTS += 4 * CONSTANTS.SECONDS_IN_A_DAY + 100;
        await setNextBlockTimestamp(currentTS);

        const amount = toToken(1_000_000);

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditContract.connect(borrower).drawdown(amount);

        const [protocolReward, poolOwnerReward, eaReward, poolProfit, amountToBorrower] =
            await feeCalculator.calcPoolFeesForDrawdown(amount);
        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.add(amountToBorrower),
        );
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesProfits,
            expectedFirstLossCoverProfits,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitCalculation(poolProfit, tracker);
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesProfits[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForProfit(
            expectedTranchesAssets,
            expectedFirstLossCoverProfits,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        const expectedPoolSafeBalanceIncrement = protocolReward
            .add(poolOwnerReward)
            .add(eaReward)
            .add(expectedTranchesProfits[CONSTANTS.JUNIOR_TRANCHE]);
        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance.sub(amount).add(expectedPoolSafeBalanceIncrement),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 5, day after the epoch end date: Close epoch and complete fulfillment of redemption requests", async function () {
        let cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        const jAmountProcessed =
            await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);
        await epochManagerContract.closeEpoch();
        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
            juniorOldShares.sub(juniorSharesRequested),
            1,
        );
        expect(jAmountProcessed).to.be.gt(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
            juniorOldAssets.sub(jAmountProcessed),
            1,
        );
        expect(
            await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
        ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 1);
        await epochChecker.checkJuniorRedemptionSummaryById(
            currentEpochId,
            juniorSharesRequested,
            juniorSharesRequested,
            jAmountProcessed,
            1,
        );

        jLenderAmountsProcessed[0] = jLenderAmountsProcessed[0].add(jAmountProcessed);
        jLenderShareRequests[0] = BN.from(0);
        jLenderPrincipalRequests[0] = BN.from(0);
        expect(
            await juniorTrancheVaultContract.withdrawableAssets(jActiveLenders[0].address),
        ).to.be.closeTo(jLenderAmountsProcessed[0], 1);
        juniorSharesRequested = BN.from(0);

        const expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01").add(1, "month").unix();
        expect(newEndTime).to.equal(expectedEndTime);
        currentEpochId = newEpochId;
    });

    it("Epoch 6, day 6: No payment from the borrower on late payment deadline", async function () {
        currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY + 100;
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

        const oldFees = await poolFeeManagerContract.getAccruedIncomes();
        const borrowerFLCOldBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );
        const adminFLCOldBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await pnlCalculator.beginProfitCalculation();
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        await creditManagerContract.connect(evaluationAgent).triggerDefault(borrower.address);
        cr = await creditContract.getCreditRecord(creditHash);
        const dd = await creditContract.getDueDetail(creditHash);
        const profit = cr.yieldDue.add(dd.yieldPastDue).add(dd.lateFee);
        const loss = cr.nextDue.add(cr.totalPastDue).add(cr.unbilledPrincipal);

        const [protocolReward, poolOwnerReward, eaReward, poolProfit] =
            await feeCalculator.calcPoolFeesForProfit(profit);
        await checkPoolFees(oldFees, protocolReward, poolOwnerReward, eaReward);

        const [
            expectedTranchesAssets,
            expectedTranchesLosses,
            expectedFirstLossCoverLosses,
            newTracker,
        ] = await pnlCalculator.endFixedSeniorYieldProfitAndLossCalculation(
            poolProfit,
            tracker,
            loss,
        );
        expect(expectedTranchesAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        expect(expectedTranchesLosses[CONSTANTS.SENIOR_TRANCHE]).to.equal(0);
        tracker = await tranchesPolicyContract.seniorYieldTracker();
        checkSeniorYieldTrackersMatch(tracker, newTracker);

        await checkAssetsForLoss(
            expectedTranchesAssets,
            expectedFirstLossCoverLosses,
            borrowerFLCOldBalance,
            adminFLCOldBalance,
        );

        const expectedPoolSafeBalanceIncrement = expectedFirstLossCoverLosses[
            CONSTANTS.BORROWER_LOSS_COVER_INDEX
        ]
            .add(expectedFirstLossCoverLosses[CONSTANTS.ADMIN_LOSS_COVER_INDEX])
            .mul(-1);
        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance.add(expectedPoolSafeBalanceIncrement),
        );

        await checkLenderAssets(expectedTranchesAssets);
    });

    it("Epoch 9, day 25: The borrower makes some payment back and distributes loss recovery", async function () {
        currentTS += 24 * CONSTANTS.SECONDS_IN_A_DAY + 100;
        await setNextBlockTimestamp(currentTS);

        const amount = toToken(800_000);

        const borrowerOldBalance = await mockTokenContract.balanceOf(borrower.address);
        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const borrowerFLCOldAssets = await borrowerFirstLossCoverContract.totalAssets();
        const adminFLCOldAssets = await adminFirstLossCoverContract.totalAssets();
        const poolSafeOldBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        await creditContract.connect(borrower).makePayment(borrower.address, amount);
        expect(await mockTokenContract.balanceOf(borrower.address)).to.equal(
            borrowerOldBalance.sub(amount),
        );
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
            juniorOldAssets.add(amount),
        );
        expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(borrowerFLCOldAssets);
        expect(await adminFirstLossCoverContract.totalAssets()).to.equal(adminFLCOldAssets);
        expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
            poolSafeOldBalance.add(amount),
        );
    });

    it("Epoch 9, day after the epoch end date: Process yield and close epoch and no fulfillment of redemption requests", async function () {
        const cr = await creditContract.getCreditRecord(creditHash);
        currentTS = cr.nextDueDate.toNumber() + 100;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        await epochChecker.checkJuniorCurrentRedemptionSummaryEmpty();

        await epochManagerContract.closeEpoch();

        const [newEpochId, newEndTime] = await epochManagerContract.currentEpoch();
        expect(newEpochId).to.equal(currentEpochId.add(1));
        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(juniorOldShares);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(juniorOldAssets);
        expect(await mockTokenContract.balanceOf(juniorTrancheVaultContract.address)).to.equal(
            juniorOldBalance,
        );

        let expectedEndTime = timestampToMoment(currentTS, "YYYY-MM-01").add(1, "month").unix();
        expect(newEndTime).to.equal(expectedEndTime);
        currentEpochId = newEpochId;
    });

    it("Epoch 10, day 10: Some lenders request redemption prior to pool closure", async function () {
        currentTS += 9 * CONSTANTS.SECONDS_IN_A_DAY + 100;
        await setNextBlockTimestamp(currentTS);

        await testRedemptionRequest(
            [
                // First junior lender requests full redemption.
                await juniorTrancheVaultContract.balanceOf(jActiveLenders[0].address),
                // Second junior lender requests partial redemption.
                (await juniorTrancheVaultContract.balanceOf(jActiveLenders[1].address)).div(2),
                // Third junior lender does not request redemption.
                BN.from(0),
            ],
            [],
        );
    });

    it("Epoch 10, day 15: Close pool and process the final redemption requests in the final epoch", async function () {
        currentTS += 5 * CONSTANTS.SECONDS_IN_A_DAY;
        await setNextBlockTimestamp(currentTS);

        await testYieldPayout();

        const juniorOldAssets = await juniorTrancheVaultContract.totalAssets();
        const juniorOldShares = await juniorTrancheVaultContract.totalSupply();
        const juniorOldBalance = await mockTokenContract.balanceOf(
            juniorTrancheVaultContract.address,
        );
        const jAmountProcessed =
            await juniorTrancheVaultContract.convertToAssets(juniorSharesRequested);

        await poolContract.connect(poolOwner).closePool();

        expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
            juniorOldShares.sub(juniorSharesRequested),
            1,
        );
        expect(jAmountProcessed).to.be.gt(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
            juniorOldAssets.sub(jAmountProcessed),
            2,
        );
        expect(
            await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
        ).to.be.closeTo(juniorOldBalance.add(jAmountProcessed), 2);
        await epochChecker.checkJuniorRedemptionSummaryById(
            currentEpochId,
            juniorSharesRequested,
            juniorSharesRequested,
            jAmountProcessed,
            2,
        );

        for (let i = 0; i < jActiveLenders.length; i++) {
            if (jLenderShareRequests[i].gt(0)) {
                jLenderAmountsProcessed[i] = jLenderAmountsProcessed[i].add(
                    jAmountProcessed.mul(jLenderShareRequests[i]).div(juniorSharesRequested),
                );
                jLenderShareRequests[i] = BN.from(0);
                jLenderPrincipalRequests[i] = BN.from(0);
            }
        }
        juniorSharesRequested = BN.from(0);
    });

    it("Epoch 10, day 15: All lenders withdraw their assets", async function () {
        for (const [i, jLender] of jActiveLenders.entries()) {
            const amountDisbursable = jLenderAmountsProcessed[i].sub(jLenderWithdrawals[i]);
            const numShares = await juniorTrancheVaultContract.balanceOf(jLender.getAddress());
            const expectedAssetsWithdrawn =
                await juniorTrancheVaultContract.convertToAssets(numShares);
            if (i === 0) {
                // The first junior lender has requested redemption for all their shares.
                expect(numShares).to.equal(0);
                expect(expectedAssetsWithdrawn).to.equal(0);
                expect(amountDisbursable).to.be.gt(0);
            } else if (i === 1) {
                // The second junior lender has requested partial redemption.
                expect(numShares).to.be.gt(0);
                expect(expectedAssetsWithdrawn).to.be.gt(0);
                expect(amountDisbursable).to.be.gt(0);
            } else {
                // The second junior lender didn't request redemption.
                expect(numShares).to.be.gt(0);
                expect(expectedAssetsWithdrawn).to.be.gt(0);
                expect(amountDisbursable).to.equal(0);
            }
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
            ).to.be.closeTo(amountDisbursable.add(expectedAssetsWithdrawn), 2);

            const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
            const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
            const oldLenderBalance = await mockTokenContract.balanceOf(jLender.getAddress());
            const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );

            if (i === 0) {
                await expect(
                    juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                )
                    .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                        isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                    )
                    .not.to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn");
            } else if (i === 1) {
                await expect(
                    juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                )
                    .to.emit(juniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(await jLender.getAddress(), (actualAmountDisbursed: BN) =>
                        isCloseTo(actualAmountDisbursed, amountDisbursable, 2),
                    )
                    .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                    .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn);
            } else {
                await expect(
                    juniorTrancheVaultContract.connect(jLender).withdrawAfterPoolClosure(),
                )
                    .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                    .withArgs(await jLender.getAddress(), numShares, expectedAssetsWithdrawn)
                    .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");
            }

            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                oldTotalSupply.sub(numShares),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                oldTotalAssets.sub(expectedAssetsWithdrawn),
            );
            expect(await mockTokenContract.balanceOf(jLender.getAddress())).to.be.closeTo(
                oldLenderBalance.add(expectedAssetsWithdrawn).add(amountDisbursable),
                2,
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(oldJuniorTrancheBalance.sub(amountDisbursable), 2);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(jLender.getAddress()),
            ).to.equal(0);
        }
    });

    it("Epoch 10, day 16: The pool owner and EA withdraw their assets from tranches", async function () {
        currentTS += CONSTANTS.SECONDS_IN_A_DAY;

        // Make sure the pool owner and EA can withdraw assets even if the liquidity requirement is not set to 0.
        const adminRnR = await poolConfigContract.getAdminRnR();
        expect(adminRnR.liquidityRateInBpsByPoolOwner).to.be.gt(0);
        expect(adminRnR.liquidityRateInBpsByEA).to.be.gt(0);

        for (const [i, admin] of [poolOwnerTreasury, evaluationAgent].entries()) {
            const numShares = await juniorTrancheVaultContract.balanceOf(admin.getAddress());
            const expectedAssetsWithdrawn =
                await juniorTrancheVaultContract.convertToAssets(numShares);

            const oldTotalSupply = await juniorTrancheVaultContract.totalSupply();
            const oldTotalAssets = await juniorTrancheVaultContract.totalAssets();
            const oldLenderBalance = await mockTokenContract.balanceOf(admin.getAddress());
            const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            const oldJuniorTrancheBalance = await mockTokenContract.balanceOf(
                juniorTrancheVaultContract.address,
            );

            await expect(juniorTrancheVaultContract.connect(admin).withdrawAfterPoolClosure())
                .to.emit(juniorTrancheVaultContract, "LenderFundWithdrawn")
                .withArgs(await admin.getAddress(), numShares, expectedAssetsWithdrawn)
                .not.to.emit(juniorTrancheVaultContract, "LenderFundDisbursed");

            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                oldTotalSupply.sub(numShares),
            );
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                oldTotalAssets.sub(expectedAssetsWithdrawn),
            );
            expect(await mockTokenContract.balanceOf(admin.getAddress())).to.be.closeTo(
                oldLenderBalance.add(expectedAssetsWithdrawn),
                2,
            );
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                oldPoolSafeBalance.sub(expectedAssetsWithdrawn),
            );
            expect(
                await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
            ).to.be.closeTo(oldJuniorTrancheBalance, 2);
            expect(
                await juniorTrancheVaultContract.withdrawableAssets(admin.getAddress()),
            ).to.equal(0);
        }

        expect(await juniorTrancheVaultContract.totalSupply()).to.equal(0);
        expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
    });

    it("Epoch 10, day 16: All first loss cover providers withdraw their assets", async function () {
        currentTS += CONSTANTS.SECONDS_IN_A_DAY;

        // Borrower redeems from first loss cover.
        const borrowerShares = await borrowerFirstLossCoverContract.balanceOf(
            borrower.getAddress(),
        );
        const borrowerAssets = await borrowerFirstLossCoverContract.totalAssetsOf(
            borrower.getAddress(),
        );
        const oldBorrowerBalance = await mockTokenContract.balanceOf(borrower.getAddress());
        const oldBorrowerFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
            borrowerFirstLossCoverContract.address,
        );

        await borrowerFirstLossCoverContract
            .connect(borrower)
            .redeemCover(borrowerShares, borrower.getAddress());

        expect(await borrowerFirstLossCoverContract.balanceOf(borrower.getAddress())).to.equal(0);
        expect(await borrowerFirstLossCoverContract.totalAssetsOf(borrower.getAddress())).to.equal(
            0,
        );
        expect(await mockTokenContract.balanceOf(borrower.getAddress())).to.equal(
            oldBorrowerBalance.add(borrowerAssets),
        );
        expect(await mockTokenContract.balanceOf(borrowerFirstLossCoverContract.address)).to.equal(
            oldBorrowerFirstLossCoverContractBalance.sub(borrowerAssets),
        );
        expect(await borrowerFirstLossCoverContract.totalSupply()).to.equal(0);
        expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);

        // Huma treasury redeems from first loss cover.
        const humaTreasuryShares = await adminFirstLossCoverContract.balanceOf(
            humaTreasury.getAddress(),
        );
        const humaTreasuryAssets = await adminFirstLossCoverContract.totalAssetsOf(
            humaTreasury.getAddress(),
        );
        const oldHumaTreasuryBalance = await mockTokenContract.balanceOf(
            humaTreasury.getAddress(),
        );
        let oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );

        await adminFirstLossCoverContract
            .connect(humaTreasury)
            .redeemCover(humaTreasuryShares, humaTreasury.getAddress());

        expect(await adminFirstLossCoverContract.balanceOf(humaTreasury.getAddress())).to.equal(0);
        expect(
            await adminFirstLossCoverContract.totalAssetsOf(humaTreasury.getAddress()),
        ).to.equal(0);
        expect(await mockTokenContract.balanceOf(humaTreasury.getAddress())).to.equal(
            oldHumaTreasuryBalance.add(humaTreasuryAssets),
        );
        expect(await mockTokenContract.balanceOf(adminFirstLossCoverContract.address)).to.equal(
            oldAdminFirstLossCoverContractBalance.sub(humaTreasuryAssets),
        );

        // Pool owner treasury redeems from first loss cover.
        const poolOwnerTreasuryShares = await adminFirstLossCoverContract.balanceOf(
            poolOwnerTreasury.getAddress(),
        );
        const poolOwnerTreasuryAssets = await adminFirstLossCoverContract.totalAssetsOf(
            poolOwnerTreasury.getAddress(),
        );
        const oldPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
            poolOwnerTreasury.getAddress(),
        );
        oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );

        await adminFirstLossCoverContract
            .connect(poolOwnerTreasury)
            .redeemCover(poolOwnerTreasuryShares, poolOwnerTreasury.getAddress());

        expect(
            await adminFirstLossCoverContract.balanceOf(poolOwnerTreasury.getAddress()),
        ).to.equal(0);
        expect(
            await adminFirstLossCoverContract.totalAssetsOf(poolOwnerTreasury.getAddress()),
        ).to.equal(0);
        expect(await mockTokenContract.balanceOf(poolOwnerTreasury.getAddress())).to.equal(
            oldPoolOwnerTreasuryBalance.add(poolOwnerTreasuryAssets),
        );
        expect(await mockTokenContract.balanceOf(adminFirstLossCoverContract.address)).to.equal(
            oldAdminFirstLossCoverContractBalance.sub(poolOwnerTreasuryAssets),
        );

        // EA redeems from first loss cover.
        const eaShares = await adminFirstLossCoverContract.balanceOf(evaluationAgent.getAddress());
        const eaAssets = await adminFirstLossCoverContract.totalAssetsOf(
            evaluationAgent.getAddress(),
        );
        const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
        oldAdminFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
            adminFirstLossCoverContract.address,
        );

        await adminFirstLossCoverContract
            .connect(evaluationAgent)
            .redeemCover(eaShares, evaluationAgent.getAddress());

        expect(await adminFirstLossCoverContract.balanceOf(evaluationAgent.getAddress())).to.equal(
            0,
        );
        expect(
            await adminFirstLossCoverContract.totalAssetsOf(evaluationAgent.getAddress()),
        ).to.equal(0);
        expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
            oldEABalance.add(eaAssets),
        );
        expect(await mockTokenContract.balanceOf(adminFirstLossCoverContract.address)).to.equal(
            oldAdminFirstLossCoverContractBalance.sub(eaAssets),
        );
        expect(await adminFirstLossCoverContract.totalSupply()).to.equal(0);
        expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
    });
});
