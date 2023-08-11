const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployAndSetupPoolContracts} = require("./BaseTest");
const {toToken} = require("./TestUtils");

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
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            lender
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

    describe("Operation Tests", function () {
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

            expect(
                await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address)
            ).to.equal(true);
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

            expect(
                await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address)
            ).to.equal(false);
        });
    });

    describe("Depost Tests", function () {
        it("Should not input zero address receiver", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(0, ethers.constants.AddressZero)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAddressProvided");
        });

        it("Should not deposit while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.deposit(0, lender.address)
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.deposit(0, lender.address)
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-Lender to deposit", async function () {
            await expect(juniorTrancheVaultContract.deposit(0, lender.address)).to.be.revertedWith(
                /AccessControl: account .*/
            );
        });

        it("Should not deposit 0 amount", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(0, lender.address)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not deposit the amount exceeding cap", async function () {
            let lpConfig = await poolConfigContract.getLPConfig();
            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(lpConfig.liquidityCap.add(BN.from(1)), lender.address)
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "exceededPoolLiquidityCap"
            );
        });

        it("Should not deposit while new senior total assets exceeds maxJuniorSeniorRatio", async function () {
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address)
            ).to.be.revertedWithCustomError(
                seniorTrancheVaultContract,
                "exceededMaxJuniorSeniorRatio"
            );
        });

        // it.only("Should deposit successfully", async function () {
        //     await juniorTrancheVaultContract
        //         .connect(lender)
        //         .deposit(toToken(10_000), lender.address);
        // });
    });
});
