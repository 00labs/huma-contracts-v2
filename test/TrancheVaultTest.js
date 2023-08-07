const {ethers} = require("hardhat");
const {expect} = require("chai");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployContracts, deployAndSetupPool} = require("./BaseTest");

let defaultDeployer;
let protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner;

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

describe("TrancheVault", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployContracts(
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
        ] = await deployAndSetupPool(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            eaServiceAccount
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("test", async function () {
        console.log(`poolConfigContract: ${poolConfigContract.address}`);
        console.log(`platformFeeManagerContract: ${platformFeeManagerContract.address}`);
        console.log(`poolVaultContract: ${poolVaultContract.address}`);
        console.log(`calendarContract: ${calendarContract.address}`);
        console.log(`lossCovererContract: ${lossCovererContract.address}`);
        console.log(`tranchesPolicyContract: ${tranchesPolicyContract.address}`);
        console.log(`poolContract: ${poolContract.address}`);
        console.log(`epochManagerContract: ${epochManagerContract.address}`);
        console.log(`seniorTrancheVaultContract: ${seniorTrancheVaultContract.address}`);
        console.log(`juniorTrancheVaultContract: ${juniorTrancheVaultContract.address}`);
        console.log(`creditContract: ${creditContract.address}`);
    });
});
