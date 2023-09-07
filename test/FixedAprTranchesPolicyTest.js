const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const moment = require("moment");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    PnLCalculator,
} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp, setNextBlockTimestamp} = require("./TestUtils");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    lossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract,
    creditFeeManagerContract,
    creditPnlManagerContract;

describe("FixedAprTranchesPolicy Test", function () {
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
            poolOwner
        );

        [
            poolConfigContract,
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            lossCovererContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
            creditFeeManagerContract,
            creditPnlManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "FixedAprTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender]
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

    it("Should call calcTranchesAssetsForProfit correctly", async function () {
        const APR = BN.from(1217);
        let lpConfig = await poolConfigContract.getLPConfig();
        let newLpConfig = {...lpConfig, fixedSeniorYieldInBps: APR};
        await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);
        let deployedAssets = toToken(300_000);
        await creditContract.drawdown(ethers.constants.HashZero, deployedAssets);
        let assets = await poolContract.currentTranchesAssets();
        let profit = toToken(12463);
        let lastDate = moment.utc("2023-08-01").unix();
        let lastBlock = await ethers.provider.getBlock();
        let nextDate = lastBlock.timestamp + 10;
        await mineNextBlockWithTimestamp(nextDate);
        let newAssets = PnLCalculator.calcProfitForFixedAprPolicy(
            profit,
            assets,
            lastDate,
            nextDate,
            deployedAssets,
            APR
        );
        let result = await tranchesPolicyContract.calcTranchesAssetsForProfit(
            profit,
            assets,
            lastDate
        );
        // expect(result[CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
        //     newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        // );
        // expect(result[CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
        //     newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        // );
    });
});
