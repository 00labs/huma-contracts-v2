const {ethers} = require("hardhat");
const {expect} = require("chai");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployPoolContracts} = require("./BaseTest");

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

describe("TrancheVault Test", function () {
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

    // it("test", async function () {
    //     console.log(`poolConfigContract: ${poolConfigContract.address}`);
    //     console.log(`platformFeeManagerContract: ${platformFeeManagerContract.address}`);
    //     console.log(`poolVaultContract: ${poolVaultContract.address}`);
    //     console.log(`calendarContract: ${calendarContract.address}`);
    //     console.log(`lossCovererContract: ${lossCovererContract.address}`);
    //     console.log(`tranchesPolicyContract: ${tranchesPolicyContract.address}`);
    //     console.log(`poolContract: ${poolContract.address}`);
    //     console.log(`epochManagerContract: ${epochManagerContract.address}`);
    //     console.log(`seniorTrancheVaultContract: ${seniorTrancheVaultContract.address}`);
    //     console.log(`juniorTrancheVaultContract: ${juniorTrancheVaultContract.address}`);
    //     console.log(`creditContract: ${creditContract.address}`);
    // });

    it("Should not allow non-Operator to add a lender", async function () {
        await expect(
            juniorTrancheVaultContract.addApprovedLender(defaultDeployer.address)
        ).to.be.revertedWithCustomError(poolConfigContract, "poolOperatorRequired");
    });

    it("Should allow Operator to add a lender", async function () {
        let role = await poolConfigContract.POOL_OPERATOR_ROLE();
        await poolConfigContract.connect(poolOwner).grantRole(role, defaultDeployer.address);

        role = await juniorTrancheVaultContract.LENDER_ROLE();
        await expect(
            juniorTrancheVaultContract
                .connect(defaultDeployer)
                .addApprovedLender(defaultDeployer.address)
        )
            .to.emit(juniorTrancheVaultContract, "RoleGranted")
            .withArgs(role, defaultDeployer.address, defaultDeployer.address);

        expect(await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address)).to.equal(
            true
        );
    });

    it("Should not allow non-Operator to remove a lender", async function () {
        await expect(
            juniorTrancheVaultContract.removeApprovedLender(defaultDeployer.address)
        ).to.be.revertedWithCustomError(poolConfigContract, "poolOperatorRequired");
    });

    it("Should allow Operator to add a lender", async function () {
        let role = await poolConfigContract.POOL_OPERATOR_ROLE();
        await poolConfigContract.connect(poolOwner).grantRole(role, defaultDeployer.address);
        await juniorTrancheVaultContract
            .connect(defaultDeployer)
            .addApprovedLender(defaultDeployer.address);

        role = await juniorTrancheVaultContract.LENDER_ROLE();
        await expect(
            juniorTrancheVaultContract
                .connect(defaultDeployer)
                .removeApprovedLender(defaultDeployer.address)
        )
            .to.emit(juniorTrancheVaultContract, "RoleRevoked")
            .withArgs(role, defaultDeployer.address, defaultDeployer.address);

        expect(await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address)).to.equal(
            false
        );
    });
});
