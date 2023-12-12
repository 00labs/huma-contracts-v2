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
    printSeniorData,
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

    const apy = 1200;

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

        await overrideLPConfig(poolConfigContract, poolOwner, {
            fixedSeniorYieldInBps: apy,
        });
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("Distribution", function () {
        it("Profit is not enough for senior tranche", async function () {
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
            expect(afterSeniorData.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Profit is enough for both senior tranche and junior tranche", async function () {
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
            expect(afterSeniorData.totalAssets).to.equal(newAssets[CONSTANTS.SENIOR_TRANCHE]);
        });

        it("Distribute loss", async function () {
            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            // printSeniorData(seniorData);
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets;
            await creditContract.mockDistributePnL(BN.from(0), toToken(100), BN.from(0));
            seniorData = await tranchesPolicyContract.seniorYieldData();
            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });

        it("Distribute loss recovery", async function () {
            await creditContract.mockDistributePnL(BN.from(0), toToken(100), BN.from(0));

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            printSeniorData(seniorData);
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets;
            await creditContract.mockDistributePnL(BN.from(0), BN.from(0), toToken(100));
            seniorData = await tranchesPolicyContract.seniorYieldData();
            printSeniorData(seniorData);
            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });
    });

    describe("LP deposit/withdraw", function () {
        it("Deposit into senior tranche", async function () {
            let seniorData = await tranchesPolicyContract.seniorYieldData();
            // printSeniorData(seniorData);

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            const amount = toToken(1000);
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets.add(amount);

            await seniorTrancheVaultContract.connect(lender).deposit(amount, lender.address);

            seniorData = await tranchesPolicyContract.seniorYieldData();

            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });

        it("Deposit into junior tranche", async function () {
            let seniorData = await tranchesPolicyContract.seniorYieldData();
            // printSeniorData(seniorData);

            const lastBlock = await getLatestBlock();
            let nextDate = lastBlock.timestamp + 100;
            await setNextBlockTimestamp(nextDate);

            const amount = toToken(1000);
            let newSeniorData = PnLCalculator.calcLatestSeniorData(nextDate, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets;

            await juniorTrancheVaultContract.connect(lender).deposit(amount, lender.address);

            seniorData = await tranchesPolicyContract.seniorYieldData();

            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });

        it("Withdraw from senior tranche", async function () {
            let shares = toToken(1000);
            await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            // printSeniorData(seniorData);

            let newSeniorData = PnLCalculator.calcLatestSeniorData(ts, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets.sub(shares);

            await epochManagerContract.closeEpoch();

            seniorData = await tranchesPolicyContract.seniorYieldData();
            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });

        it("Withdraw from junior tranche", async function () {
            let shares = toToken(1000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            let lastEpoch = await epochManagerContract.currentEpoch();
            let ts = lastEpoch.endTime.toNumber() + 60 * 5;
            await setNextBlockTimestamp(ts);

            let seniorData = await tranchesPolicyContract.seniorYieldData();
            // printSeniorData(seniorData);

            let newSeniorData = PnLCalculator.calcLatestSeniorData(ts, apy, seniorData);
            newSeniorData.totalAssets = seniorData.totalAssets;

            await epochManagerContract.closeEpoch();

            seniorData = await tranchesPolicyContract.seniorYieldData();
            checkSeniorDatasMatch(seniorData, newSeniorData);
            expect(seniorData.unpaidYield).to.greaterThan(0);
        });
    });
});
