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
} from "../typechain-types";
import {
    CONSTANTS,
    PnLCalculator,
    SeniorYieldData,
    checkSeniorDatasMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "./BaseTest";
import {
    getLatestBlock,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    setNextBlockTimestamp,
    toToken,
} from "./TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
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

describe.only("FixedSeniorYieldTranchePolicy Test", function () {
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
            lender,
        ] = await ethers.getSigners();
    });

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
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("distribute profit", function () {
        it("Profit is not enough for senior tranche", async function () {
            const apy = 1217;
            await overrideLPConfig(poolConfigContract, poolOwner, {
                fixedSeniorYieldInBps: apy,
            });
            const deployedAssets = toToken(300_000);
            await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
            const assets = await poolContract.currentTranchesAssets();
            let profit = BN.from(10);
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 10;
            await mineNextBlockWithTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            let [, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                seniorData,
            );

            const afterAssets = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            expect(afterAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(afterAssets[CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(afterAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                assets[CONSTANTS.SENIOR_TRANCHE].add(profit),
            );
            expect(afterAssets[CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );

            nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let newSeniorData: SeniorYieldData;
            [newSeniorData, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                seniorData,
            );
            // printSeniorData(newSeniorData);
            await tranchesPolicyContract.distProfitToTranches(profit, assets);
            const afterSeniorData = await tranchesPolicyContract.seniorYieldData();
            checkSeniorDatasMatch(afterSeniorData, newSeniorData);
            expect(afterSeniorData.unpaidYield).to.greaterThan(0);
            expect(afterSeniorData.lastUpdatedDate).to.equal(nextDate);
            expect(afterSeniorData.seniorDebt).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Profit is enough for both senior tranche and junior tranche", async function () {
            const apy = 1217;
            await overrideLPConfig(poolConfigContract, poolOwner, {
                fixedSeniorYieldInBps: apy,
            });
            const deployedAssets = toToken(300_000);
            await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
            const assets = await poolContract.currentTranchesAssets();
            let profit = toToken(1000);
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 10;
            await mineNextBlockWithTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            let [, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                seniorData,
            );

            const afterAssets = await tranchesPolicyContract.callStatic.distProfitToTranches(
                profit,
                assets,
            );
            expect(afterAssets[CONSTANTS.SENIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(afterAssets[CONSTANTS.JUNIOR_TRANCHE]).to.equal(
                newAssets[CONSTANTS.JUNIOR_TRANCHE],
            );
            expect(afterAssets[CONSTANTS.SENIOR_TRANCHE]).to.greaterThan(
                assets[CONSTANTS.SENIOR_TRANCHE],
            );
            expect(afterAssets[CONSTANTS.JUNIOR_TRANCHE]).to.greaterThan(
                assets[CONSTANTS.JUNIOR_TRANCHE],
            );

            nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let newSeniorData: SeniorYieldData;
            [newSeniorData, newAssets] = PnLCalculator.calcProfitForFixedSeniorYieldPolicy(
                profit,
                assets,
                nextDate,
                apy,
                seniorData,
            );
            // printSeniorData(newSeniorData);
            await tranchesPolicyContract.distProfitToTranches(profit, assets);
            const afterSeniorData = await tranchesPolicyContract.seniorYieldData();
            checkSeniorDatasMatch(afterSeniorData, newSeniorData);
            expect(afterSeniorData.unpaidYield).to.equal(0);
            expect(afterSeniorData.lastUpdatedDate).to.equal(nextDate);
            expect(afterSeniorData.seniorDebt).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });
    });

    describe("distribute loss", function () {
        it("Refresh data after distributing", async function () {
            const apy = 1217;
            await overrideLPConfig(poolConfigContract, poolOwner, {
                fixedSeniorYieldInBps: apy,
            });
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.JUNIOR_TRANCHE];
            let lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            await tranchesPolicyContract.distLossToTranches(loss, assets);
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            let afterSeniorData = await tranchesPolicyContract.seniorYieldData();
            expect(newSeniorData.lastUpdatedDate).to.equal(nextDate);
            expect(newSeniorData.unpaidYield).to.equal(afterSeniorData.unpaidYield);
            expect(seniorData.seniorDebt).to.equal(afterSeniorData.seniorDebt);
            // printSeniorData(seniorData);
            // printSeniorData(newSeniorData);
        });
    });

    describe("distribute loss recovery", function () {
        it("Refresh data after distributing", async function () {
            const apy = 1217;
            await overrideLPConfig(poolConfigContract, poolOwner, {
                fixedSeniorYieldInBps: apy,
            });
            const assets = await poolContract.currentTranchesAssets();
            const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]);
            const recovery = loss;

            const [assetsAfterLosses, losses] =
                await tranchesPolicyContract.callStatic.distLossToTranches(loss, assets);
            const [, newAssetsWithLossRecovery, newLossesWithLossRecovery] =
                await PnLCalculator.calcLossRecovery(recovery, assetsAfterLosses, losses, [
                    BN.from(0),
                    BN.from(0),
                ]);
            let lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            await tranchesPolicyContract.distLossRecoveryToTranches(
                recovery,
                assetsAfterLosses,
                losses,
            );
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            let afterSeniorData = await tranchesPolicyContract.seniorYieldData();
            expect(newSeniorData.lastUpdatedDate).to.equal(nextDate);
            expect(newSeniorData.unpaidYield).to.equal(afterSeniorData.unpaidYield);
            expect(afterSeniorData.seniorDebt).to.equal(assets[CONSTANTS.SENIOR_TRANCHE]);
            // printSeniorData(seniorData);
            // printSeniorData(newSeniorData);
        });
    });
});
