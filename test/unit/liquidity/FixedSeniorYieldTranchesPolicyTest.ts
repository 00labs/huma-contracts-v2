import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    FixedSeniorYieldTranchePolicy,
    HumaConfig,
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    TrancheVault,
} from "../../../typechain-types";
import {
    CONSTANTS,
    PnLCalculator,
    SeniorYieldTracker,
    checkSeniorYieldTrackersMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    printSeniorYieldTracker,
} from "../../BaseTest";
import {
    getLatestBlock,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: FixedSeniorYieldTranchePolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("FixedSeniorYieldTranchePolicy Test", function () {
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
            lender,
        ] = await ethers.getSigners();
    });

    const apy = 1200;

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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "FixedSeniorYieldTranchePolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "BorrowerLevelCreditManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );

        let juniorDepositAmount = toToken(100_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(300_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);

        await overrideLPConfig(poolConfigContract, poolOwner, {
            fixedSeniorYieldInBps: apy,
        });
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-pool or non-poolConfig to call refreshSeniorYield", async function () {
        await expect(
            tranchesPolicyContract.refreshYieldTracker([0, 0]),
        ).to.be.revertedWithCustomError(tranchesPolicyContract, "todo");
    });

    describe("getFirstLossCovers", function () {
        it("Should return the first loss covers", async function () {
            expect(await tranchesPolicyContract.getFirstLossCovers()).to.eql([
                borrowerFirstLossCoverContract.address,
                affiliateFirstLossCoverContract.address,
            ]);
        });
    });

    describe("Distribution", function () {
        it("Profit is not enough for senior tranche", async function () {
            const deployedAssets = toToken(300_000);
            await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
            const assets = await poolContract.currentTranchesAssets();
            let profit = BN.from(100);
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 60;
            await mineNextBlockWithTimestamp(nextDate);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            let [, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                tracker,
            );

            const result = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            console.log(`result: ${result}`);
            expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE].sub(assets[CONSTANTS.SENIOR_TRANCHE]),
            );
            expect(result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE]).to.equal(0);

            nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let newTracker: SeniorYieldTracker;
            [newTracker, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                tracker,
            );
            await expect(tranchesPolicyContract.distProfitToTranches(profit, assets))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );
            const afterSeniorTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(afterSeniorTracker, newTracker);
            expect(afterSeniorTracker.unpaidYield).to.greaterThan(0);
            expect(afterSeniorTracker.lastUpdatedDate).to.equal(nextDate);
            expect(afterSeniorTracker.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Profit is enough for both senior tranche and junior tranche", async function () {
            const deployedAssets = toToken(300_000);
            await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
            const assets = await poolContract.currentTranchesAssets();
            let profit = toToken(1000);
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 10;
            await mineNextBlockWithTimestamp(nextDate);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            let [, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                tracker,
            );

            const result = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            console.log(`result: ${result}`);
            expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE].sub(assets[CONSTANTS.SENIOR_TRANCHE]),
            );
            let allProfit = result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE].add(
                result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE],
            );
            result.profitsForFirstLossCover.forEach((profit) => {
                allProfit = allProfit.add(profit);
            });
            expect(allProfit).to.equal(profit);
            expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.greaterThan(0);
            expect(result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE]).to.greaterThan(0);

            nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let newTracker: SeniorYieldTracker;
            [newTracker, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                tracker,
            );
            // printSeniorData(newSeniorData);
            await expect(tranchesPolicyContract.distProfitToTranches(profit, assets))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );
            const afterTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(afterTracker, newTracker);
            expect(afterTracker.unpaidYield).to.equal(0);
            expect(afterTracker.lastUpdatedDate).to.equal(nextDate);
            expect(afterTracker.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Distribute loss", async function () {
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            let newTracker = PnLCalculator.calcLatestSeniorTracker(nextDate, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets;
            await creditContract.mockDistributePnL(BN.from(0), toToken(100), BN.from(0));
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });

        it("Distribute loss recovery", async function () {
            await creditContract.mockDistributePnL(BN.from(0), toToken(100), BN.from(0));

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            printSeniorYieldTracker(tracker);
            let newTracker = PnLCalculator.calcLatestSeniorTracker(nextDate, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets;
            await creditContract.mockDistributePnL(BN.from(0), BN.from(0), toToken(100));
            tracker = await tranchesPolicyContract.seniorYieldTracker();
            // printSeniorYieldTracker(tracker);
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });
    });

    describe("LP deposit/withdraw", function () {
        it("Deposit into senior tranche", async function () {
            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            // printSeniorData(seniorData);

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            const amount = toToken(1000);
            let newTracker = PnLCalculator.calcLatestSeniorTracker(nextDate, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets.add(amount);

            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(amount, lender.address),
            )
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );

            tracker = await tranchesPolicyContract.seniorYieldTracker();

            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });

        it("Deposit into junior tranche", async function () {
            let tracker = await tranchesPolicyContract.seniorYieldTracker();

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            const amount = toToken(1000);
            let newTracker = PnLCalculator.calcLatestSeniorTracker(nextDate, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets;

            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(amount, lender.address),
            )
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );

            tracker = await tranchesPolicyContract.seniorYieldTracker();

            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });

        it("Withdraw from senior tranche", async function () {
            let shares = toToken(1000);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();

            let newTracker = PnLCalculator.calcLatestSeniorTracker(ts, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets.sub(shares);

            await expect(epochManagerContract.closeEpoch())
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });

        it("Withdraw from junior tranche", async function () {
            let shares = toToken(1000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();

            let newTracker = PnLCalculator.calcLatestSeniorTracker(ts, apy, tracker);
            newTracker.totalAssets = tracker.totalAssets;

            await expect(epochManagerContract.closeEpoch())
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });
    });

    describe("Set fixedSeniorYieldInBps", function () {
        it("Should refreshYieldTracker when fixedSeniorYieldInBps changes", async function () {
            let newApy = 2000;
            let lpConfig = await poolConfigContract.getLPConfig();
            lpConfig = { ...lpConfig, ...{ fixedSeniorYieldInBps: newApy } };

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 60 * 60;
            await setNextBlockTimestamp(nextDate);

            let tracker = await tranchesPolicyContract.seniorYieldTracker();
            console.log(`tracker: ${tracker}`);

            let newTracker = PnLCalculator.calcLatestSeniorTracker(nextDate, apy, tracker);

            await expect(poolConfigContract.connect(poolOwner).setLPConfig(lpConfig))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    newTracker.totalAssets,
                    newTracker.unpaidYield,
                    newTracker.lastUpdatedDate,
                );

            tracker = await tranchesPolicyContract.seniorYieldTracker();
            // console.log(`tracker: ${tracker}`);
            checkSeniorYieldTrackersMatch(tracker, newTracker);
            expect(tracker.unpaidYield).to.greaterThan(0);
        });
    });
});