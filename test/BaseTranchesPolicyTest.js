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
    creditContract;

describe("BaseTranchesPolicy Test", function () {
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
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "FixedAprTranchesPolicy",
            defaultDeployer,
            poolOwner,
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

    it("Junior assets can cover loss", async function () {
        let assets = await poolContract.currentTranchesAssets();
        let loss = toToken(27937);

        let [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
    });

    it("Junior assets can not cover loss", async function () {
        let assets = await poolContract.currentTranchesAssets();
        let loss = toToken(153648);

        let [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
    });

    it("Only recover senior loss", async function () {
        let assets = await poolContract.currentTranchesAssets();
        let loss = toToken(128356);

        let [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );

        let recovery = toToken(17937);
        [, newAssets, newLosses] = PnLCalculator.calcLossRecovery(recovery, result[0], result[1]);
        result = await tranchesPolicyContract.calcTranchesAssetsForLossRecovery(
            recovery,
            result[0],
            result[1]
        );
        expect(result[0]).to.equal(0);
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
        expect(result[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
    });

    it("Recover senior loss and junior loss", async function () {
        let assets = await poolContract.currentTranchesAssets();
        let loss = toToken(113638);

        let [newAssets, newLosses] = PnLCalculator.calcLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[0][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[0][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(0);
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );

        let recovery = toToken(38566);
        [, newAssets, newLosses] = PnLCalculator.calcLossRecovery(recovery, result[0], result[1]);
        result = await tranchesPolicyContract.calcTranchesAssetsForLossRecovery(
            recovery,
            result[0],
            result[1]
        );
        expect(result[0]).to.equal(0);
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[1][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            assets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[2][CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newLosses[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
        expect(result[2][CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(0);
    });
});