const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployPoolContracts} = require("./BaseTest");
const {toToken} = require("./TestUtils");

let defaultDeployer;
let protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    poolOwnerAndEAlossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract;

describe("TrancheVault Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
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
            poolOwnerAndEAlossCovererContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
        ] = await deployPoolContracts(
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

    it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
        await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
            poolConfigContract,
            "permissionDeniedNotAdmin"
        );
    });

    it.only("Should not enable a pool while no enough first loss cover", async function () {
        await expect(
            poolContract.connect(protocolOwner).enablePool()
        ).to.be.revertedWithCustomError(poolOwnerAndEAlossCovererContract, "notOperator");

        await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
        await poolConfigContract
            .connect(poolOwner)
            .setPoolOwnerTreasury(poolOwnerTreasury.address);
        await poolOwnerAndEAlossCovererContract
            .connect(poolOwner)
            .setOperator(poolOwnerTreasury.address, {
                poolCapCoverageInBps: 1000,
                poolValueCoverageInBps: 1000,
            });

        // await mockTokenContract.approve(
        //     poolOwnerAndEAlossCovererContract.address,
        //     toToken(1_000_000)
        // );
        // await poolOwnerAndEAlossCovererContract
        //     .connect(poolOwnerTreasury)
        //     .addCover(toToken(200_000));
    });
});
