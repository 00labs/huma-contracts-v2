const {ethers} = require("hardhat");
const {expect} = require("chai");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployPoolContracts} = require("./BaseTest");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender;

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

describe("PoolConfigCache Test", function () {
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
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should not allow non-poolOwner to update pool config cache", async function () {
        await expect(
            juniorTrancheVaultContract.updatePoolConfigData()
        ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
    });

    it("Should update pool config cache", async function () {
        await poolConfigContract.connect(poolOwner).setPoolVault(defaultDeployer.address);

        await expect(juniorTrancheVaultContract.connect(poolOwner).updatePoolConfigData())
            .to.emit(juniorTrancheVaultContract, "PoolConfigCacheUpdated")
            .withArgs(poolConfigContract.address);

        expect(await juniorTrancheVaultContract.poolVault()).to.equal(defaultDeployer.address);
    });

    it("Should not set pool config to empty address", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(ethers.constants.AddressZero)
        ).to.be.revertedWithCustomError(seniorTrancheVaultContract, "zeroAddressProvided");
    });

    it("Should not allow non-poolOwner to set new pool config", async function () {
        await expect(
            seniorTrancheVaultContract.setPoolConfig(poolConfigContract.address)
        ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
    });

    it("Should set new pool config", async function () {
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const newPoolConfigContract = await PoolConfig.deploy();
        await newPoolConfigContract.deployed();

        await newPoolConfigContract.initialize("Test New Pool", [
            humaConfigContract.address,
            mockTokenContract.address,
            platformFeeManagerContract.address,
            calendarContract.address,
            calendarContract.address,
            poolOwnerAndEAlossCovererContract.address,
            tranchesPolicyContract.address,
            tranchesPolicyContract.address,
            mockTokenContract.address,
            seniorTrancheVaultContract.address,
            juniorTrancheVaultContract.address,
            creditContract.address,
        ]);

        await expect(
            seniorTrancheVaultContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address)
        )
            .to.emit(seniorTrancheVaultContract, "PoolConfigChanged")
            .withArgs(newPoolConfigContract.address, poolConfigContract.address);

        expect(await seniorTrancheVaultContract.pool()).to.equal(tranchesPolicyContract.address);
        expect(await seniorTrancheVaultContract.poolVault()).to.equal(calendarContract.address);
        expect(await seniorTrancheVaultContract.epochManager()).to.equal(
            mockTokenContract.address
        );
    });
});
