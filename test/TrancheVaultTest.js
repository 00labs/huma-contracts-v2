const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {deployProtocolContracts, deployAndSetupPoolContracts, CONSTANTS} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp} = require("./TestUtils");

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
        it("Should not deposit 0 amount", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(0, lender.address)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not input zero address receiver", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), ethers.constants.AddressZero)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAddressProvided");
        });

        it("Should not allow non-Lender to deposit", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), lender.address)
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "permissionDeniedNotLender"
            );

            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(toToken(1), defaultDeployer.address)
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "permissionDeniedNotLender"
            );
        });

        it("Should not deposit while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address)
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address)
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
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

        it("Should deposit successfully", async function () {
            let amount = toToken(40_000);
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(amount, lender.address)
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender.address, amount, amount);

            expect(await poolContract.totalAssets()).to.equal(amount);
            let poolAssets = await poolContract.totalAssets();
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(amount);

            amount = toToken(10_000);
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(amount, lender.address)
            )
                .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender.address, amount, amount);
            expect(await poolContract.totalAssets()).to.equal(poolAssets.add(amount));
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await seniorTrancheVaultContract.balanceOf(lender.address)).to.equal(amount);
        });
    });

    describe("Withdraw Tests", function () {
        let juniorDepositAmount, seniorDepositAmount;

        async function prepareForWithdrawTests() {
            juniorDepositAmount = toToken(400_000);
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(juniorDepositAmount, lender.address);
            seniorDepositAmount = toToken(10_000);
            await seniorTrancheVaultContract
                .connect(lender)
                .deposit(seniorDepositAmount, lender.address);
        }

        beforeEach(async function () {
            await loadFixture(prepareForWithdrawTests);
        });

        it("Should not request 0 redemption", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).addRedemptionRequest(0)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not request redemption while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(lender).addRedemptionRequest(1)
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(lender).addRedemptionRequest(1)
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not request redemption greater than user's shares", async function () {
            let shares = await juniorTrancheVaultContract.balanceOf(lender.address);
            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(shares.add(BN.from(1)))
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "withdrawnAmountHigherThanBalance"
            );
        });

        it.only("Should request redemption in a same epoch successfully", async function () {
            let shares = toToken(10_000);
            let currentEpochId = await epochManagerContract.currentEpochId();
            // console.log(`currentEpochId: ${currentEpochId}`);
            let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
            await expect(juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares))
                .to.emit(juniorTrancheVaultContract, "RedemptionRequested")
                .withArgs(lender.address, shares, currentEpochId);

            expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                balance.sub(shares)
            );

            let userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                lender.address,
                0
            );
            expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
            expect(userRedemptionRequest.shareRequested).to.equal(shares);

            let epochId = await juniorTrancheVaultContract.epochIds(0);
            expect(epochId).to.equal(currentEpochId);
            let epoch = await juniorTrancheVaultContract.epochMap(epochId);
            expect(epoch.epochId).to.equal(currentEpochId);
            expect(epoch.totalShareRequested).to.equal(shares);

            // Close current epoch
            let currentEpoch = await epochManagerContract.currentEpoch();
            await mineNextBlockWithTimestamp(
                currentEpoch.nextEndTime.add(BN.from(60 * 5)).toNumber()
            );
            await epochManagerContract.closeEpoch();

            // // Call addRedemptionRequest in next epoch
            // await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
        });

        it("Should get removable redemption shares correctly", async function () {
            expect(
                await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
            ).to.equal(0);
            let shares = toToken(10_000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            expect(
                await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
            ).to.equal(shares);
        });

        it("Should not remove 0 redemption request", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(0)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not remove redemption request while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1)
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1)
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not remove redemption request while no any redemption was requested", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "emptyArray");
        });

        it("Should not remove redemption request after requested epochs", async function () {
            let shares = toToken(10_000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

            let nextDate = Math.ceil(Date.now() / 1000) + 60 * 60 * 24;
            await mineNextBlockWithTimestamp(nextDate);
            await poolContract.connect(poolOwner).enablePool();

            await expect(
                juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1)
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "notCurrentEpoch");
        });

        it("Should not remove redemption request greater than requested shares", async function () {
            let shares = toToken(10_000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .removeRedemptionRequest(shares.mul(BN.from(2)))
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "shareHigherThanRequested"
            );
        });

        it("Should remove redemption request successfully", async function () {
            let shares = toToken(10_000);
            await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
            await juniorTrancheVaultContract
                .connect(lender)
                .removeRedemptionRequest(toToken(1000));
        });
    });
});
