const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const moment = require("moment");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    getNextDueDate,
    checkEpochInfo,
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

function calcTranchesAssetsForLoss(loss, assets) {
    let juniorLoss = loss.gt(assets[CONSTANTS.JUNIOR_TRANCHE_INDEX])
        ? assets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        : loss;

    return [
        assets[CONSTANTS.SENIOR_TRANCHE_INDEX].sub(loss.sub(juniorLoss)),
        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].sub(juniorLoss),
    ];
}

describe("FixedAprTranchesPolicy", function () {
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

        let newAssets = calcTranchesAssetsForLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
    });

    it("Junior assets can not cover loss", async function () {
        let assets = await poolContract.currentTranchesAssets();
        let loss = toToken(153648);

        let newAssets = calcTranchesAssetsForLoss(loss, assets);
        let result = await tranchesPolicyContract.calcTranchesAssetsForLoss(loss, assets);

        expect(result[CONSTANTS.SENIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.SENIOR_TRANCHE_INDEX]
        );
        expect(result[CONSTANTS.JUNIOR_TRANCHE_INDEX]).to.equal(
            newAssets[CONSTANTS.JUNIOR_TRANCHE_INDEX]
        );
    });
});
