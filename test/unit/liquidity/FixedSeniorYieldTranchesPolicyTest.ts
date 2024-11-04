import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    FirstLossCover,
    FixedSeniorYieldTranchesPolicy,
    HumaConfig,
    MockPoolCredit,
    MockPoolCreditManager,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    TrancheVault,
} from "../../../typechain-types";
import {
    PnLCalculator,
    SeniorYieldTracker,
    checkSeniorYieldTrackersMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    mockDistributePnL,
} from "../../BaseTest";
import {
    getLatestBlock,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress;

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: FixedSeniorYieldTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditManagerContract: MockPoolCreditManager,
    creditDueManagerContract: CreditDueManager;
let seniorDepositAmount: BN;

describe("FixedSeniorYieldTranchesPolicy Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
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
        [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            "FixedSeniorYieldTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "MockPoolCreditManager",
            evaluationAgent,
            treasury,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );

        const juniorDepositAmount = toToken(100_000);
        await juniorTrancheVaultContract.connect(lender).deposit(juniorDepositAmount);
        seniorDepositAmount = toToken(300_000);
        await seniorTrancheVaultContract.connect(lender).deposit(seniorDepositAmount);

        await overrideLPConfig(poolConfigContract, poolOwner, {
            fixedSeniorYieldInBps: apy,
            withdrawalLockoutPeriodInDays: 0,
        });
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-pool or non-poolConfig to call refreshSeniorYield", async function () {
        await expect(
            tranchesPolicyContract.refreshYieldTracker([0, 0]),
        ).to.be.revertedWithCustomError(
            tranchesPolicyContract,
            "AuthorizedContractCallerRequired",
        );
    });

    describe("getFirstLossCovers", function () {
        it("Should return the first loss covers", async function () {
            expect(await tranchesPolicyContract.getFirstLossCovers()).to.eql([
                borrowerFirstLossCoverContract.address,
                adminFirstLossCoverContract.address,
            ]);
        });
    });

    describe("Distribution", function () {
        it("Should not allow non-pool to call distProfitToTranches", async function () {
            const assets = await poolContract.currentTranchesAssets();
            await expect(
                tranchesPolicyContract.distProfitToTranches(0, [...assets]),
            ).to.be.revertedWithCustomError(
                tranchesPolicyContract,
                "AuthorizedContractCallerRequired",
            );
        });

        it("Should distribute all profit to the senior tranche if unpaid yield is greater than the incoming profit", async function () {
            await creditContract.drawdown(ethers.constants.HashZero, seniorDepositAmount);
            const assets = await poolContract.currentTranchesAssets();
            const profit = toToken(100);
            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await mineNextBlockWithTimestamp(nextTS);

            const tracker = await tranchesPolicyContract.seniorYieldTracker();
            let [, newAssets] = await PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                calendarContract,
                profit,
                assets,
                nextTS.toNumber(),
                apy,
                tracker,
            );

            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await tranchesPolicyContract.connect(poolOwner).updatePoolConfigData();
            const result = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE].sub(assets[CONSTANTS.SENIOR_TRANCHE]),
            );
            expect(result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE]).to.equal(0);

            const profitDistributionTS = nextTS.add(100);
            await setNextBlockTimestamp(profitDistributionTS);

            let expectedTracker: SeniorYieldTracker;
            [expectedTracker, newAssets] = await PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                calendarContract,
                profit,
                assets,
                profitDistributionTS.toNumber(),
                apy,
                tracker,
            );
            await expect(tranchesPolicyContract.distProfitToTranches(profit, assets))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );
            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            const startOfNextDay = await calendarContract.getStartOfNextDay(nextTS);
            expect(actualTracker.unpaidYield).to.be.gt(0);
            expect(actualTracker.lastUpdatedDate).to.equal(startOfNextDay);
            expect(actualTracker.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Should distribute profit to both senior and junior tranches if there is enough profit", async function () {
            await creditContract.drawdown(ethers.constants.HashZero, seniorDepositAmount);

            const numFLCs = (await tranchesPolicyContract.getFirstLossCovers()).length;
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await tranchesPolicyContract.connect(poolOwner).updatePoolConfigData();
            expect((await tranchesPolicyContract.getFirstLossCovers()).length).to.equal(numFLCs);

            const assets = await poolContract.currentTranchesAssets();
            const profit = toToken(1000);
            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await mineNextBlockWithTimestamp(nextTS);

            const tracker = await tranchesPolicyContract.seniorYieldTracker();
            let [, newAssets] = await PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                calendarContract,
                profit,
                assets,
                nextTS.toNumber(),
                apy,
                tracker,
            );

            const result = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            let allProfit = result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE].add(
                result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE],
            );
            result.profitsForFirstLossCover.forEach((profit) => {
                allProfit = allProfit.add(profit);
            });
            expect(allProfit).to.equal(profit);
            const expectedSeniorProfit = newAssets[CONSTANTS.SENIOR_TRANCHE].sub(
                assets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(expectedSeniorProfit).to.be.gt(0);
            expect(result.profitsForTrancheVault[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                expectedSeniorProfit,
            );
            expect(result.profitsForTrancheVault[CONSTANTS.JUNIOR_TRANCHE]).to.be.gt(0);

            const profitDistributionTS = nextTS.add(100);
            await setNextBlockTimestamp(profitDistributionTS);

            let expectedTracker: SeniorYieldTracker;
            [expectedTracker, newAssets] = await PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                calendarContract,
                profit,
                assets,
                profitDistributionTS.toNumber(),
                apy,
                tracker,
            );
            await expect(tranchesPolicyContract.distProfitToTranches(profit, assets))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );
            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.equal(0);
            const startOfNextDay = await calendarContract.getStartOfNextDay(nextTS);
            expect(actualTracker.lastUpdatedDate).to.equal(startOfNextDay);
            expect(actualTracker.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Should distribute loss", async function () {
            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await setNextBlockTimestamp(nextTS);

            let actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                actualTracker,
            );
            expectedTracker.totalAssets = actualTracker.totalAssets;
            await mockDistributePnL(
                creditContract,
                creditManagerContract,
                BN.from(0),
                toToken(100),
                BN.from(0),
            );
            actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });

        it("Should distribute loss recovery", async function () {
            await mockDistributePnL(
                creditContract,
                creditManagerContract,
                BN.from(0),
                toToken(100),
                BN.from(0),
            );

            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await setNextBlockTimestamp(nextTS);

            let actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                actualTracker,
            );
            expectedTracker.totalAssets = actualTracker.totalAssets;
            await mockDistributePnL(
                creditContract,
                creditManagerContract,
                BN.from(0),
                BN.from(0),
                toToken(100),
            );
            actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });
    });

    describe("LP deposit/withdraw", function () {
        it("Should update the yield tracker when deposit is made in the senior tranche", async function () {
            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await setNextBlockTimestamp(nextTS);

            const amount = toToken(1000);
            const oldTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                oldTracker,
            );
            expectedTracker.totalAssets = oldTracker.totalAssets.add(amount);

            await expect(seniorTrancheVaultContract.connect(lender).deposit(amount))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );

            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });

        it("Should update the yield tracker when deposit is made in the junior tranche", async function () {
            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await setNextBlockTimestamp(nextTS);

            const amount = toToken(1000);
            const oldTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                oldTracker,
            );
            expectedTracker.totalAssets = oldTracker.totalAssets;

            await expect(juniorTrancheVaultContract.connect(lender).deposit(amount))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );

            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });

        it("Should update the yield tracker when withdrawal is made from the senior tranche", async function () {
            const shares = toToken(1000);
            await seniorTrancheVaultContract
                .connect(lender)
                .addRedemptionRequest(lender.address, shares);
            const lastEpoch = await epochManagerContract.currentEpoch();
            const nextTS = await calendarContract.getStartOfNextDay(lastEpoch.endTime);
            await setNextBlockTimestamp(nextTS);

            const oldTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                oldTracker,
            );
            expectedTracker.totalAssets = oldTracker.totalAssets.sub(shares);

            await expect(epochManagerContract.closeEpoch())
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );

            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });

        it("Should update the yield tracker when withdrawal is made from the junior tranche", async function () {
            const shares = toToken(1000);
            await juniorTrancheVaultContract
                .connect(lender)
                .addRedemptionRequest(lender.address, shares);
            const lastEpoch = await epochManagerContract.currentEpoch();
            const nextTS = await calendarContract.getStartOfNextDay(lastEpoch.endTime);
            await setNextBlockTimestamp(nextTS);

            const oldTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                oldTracker,
            );
            expectedTracker.totalAssets = oldTracker.totalAssets;

            await expect(epochManagerContract.closeEpoch())
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );

            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });
    });

    describe("Set fixedSeniorYieldInBps", function () {
        it("Should call refreshYieldTracker when fixedSeniorYieldInBps changes", async function () {
            const newApy = 2000;
            let lpConfig = await poolConfigContract.getLPConfig();
            lpConfig = { ...lpConfig, ...{ fixedSeniorYieldInBps: newApy } };

            const currentTS = (await getLatestBlock()).timestamp;
            const nextTS = await calendarContract.getStartOfNextDay(currentTS);
            await setNextBlockTimestamp(nextTS);

            const oldTracker = await tranchesPolicyContract.seniorYieldTracker();
            const expectedTracker = await PnLCalculator.calcLatestSeniorTracker(
                calendarContract,
                nextTS.toNumber(),
                apy,
                oldTracker,
            );

            await expect(poolConfigContract.connect(poolOwner).setLPConfig(lpConfig))
                .to.emit(tranchesPolicyContract, "YieldTrackerRefreshed")
                .withArgs(
                    expectedTracker.totalAssets,
                    expectedTracker.unpaidYield,
                    expectedTracker.lastUpdatedDate,
                );

            const actualTracker = await tranchesPolicyContract.seniorYieldTracker();
            checkSeniorYieldTrackersMatch(actualTracker, expectedTracker);
            expect(actualTracker.unpaidYield).to.be.gt(0);
        });
    });
});
