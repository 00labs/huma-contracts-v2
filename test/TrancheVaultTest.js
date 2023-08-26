const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    checkEpochInfo,
} = require("./BaseTest");
const {toToken, mineNextBlockWithTimestamp, setNextBlockTimestamp} = require("./TestUtils");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender, lender2;

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

function checkUserDisburseInfo(
    disburseInfo,
    requestsIndex,
    partialShareProcessed = 0,
    partialAmountProcessed = 0
) {
    expect(disburseInfo.requestsIndex).to.equal(requestsIndex);
    expect(disburseInfo.partialShareProcessed).to.equal(partialShareProcessed);
    expect(disburseInfo.partialAmountProcessed).to.equal(partialAmountProcessed);
}

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
            lender2,
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
            [lender, lender2]
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

        it("Should not deposit while new senior total assets exceeds maxSeniorJuniorRatio", async function () {
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address)
            ).to.be.revertedWithCustomError(
                seniorTrancheVaultContract,
                "exceededMaxJuniorSeniorRatio"
            );
        });

        it("Should deposit successfully", async function () {
            let amount = toToken(40_000);
            let balanceBefore = await mockTokenContract.balanceOf(lender.address);
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
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore.sub(amount)
            );

            amount = toToken(10_000);
            balanceBefore = await mockTokenContract.balanceOf(lender.address);
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(amount, lender2.address)
            )
                .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender2.address, amount, amount);
            expect(await poolContract.totalAssets()).to.equal(poolAssets.add(amount));
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await seniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(amount);
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore.sub(amount)
            );
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

            juniorDepositAmount = toToken(50_000);
            await juniorTrancheVaultContract
                .connect(lender2)
                .deposit(juniorDepositAmount, lender2.address);
            seniorDepositAmount = toToken(20_000);
            await seniorTrancheVaultContract
                .connect(lender2)
                .deposit(seniorDepositAmount, lender2.address);
        }

        beforeEach(async function () {
            await loadFixture(prepareForWithdrawTests);
        });

        describe("Redemption Tests", function () {
            it("Should call getRedemptionEpochLength to return 0", async function () {
                expect(await juniorTrancheVaultContract.getRedemptionEpochLength()).to.equal(0);
            });

            it("Should call getUserRedemptionRequestLength to return 0", async function () {
                expect(
                    await juniorTrancheVaultContract.getUserRedemptionRequestLength(lender.address)
                ).to.equal(0);
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

            it("Should request redemption in a same epoch successfully", async function () {
                let shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                // console.log(`currentEpochId: ${currentEpochId}`);
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares)
                );

                let userRedemptionRequest =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
                ).to.equal(shares);

                let epochId = await juniorTrancheVaultContract.epochIds(0);
                expect(epochId).to.equal(currentEpochId);
                let epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                // Lender requests redemption again

                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares)
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    0
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares.mul(BN.from(2)));

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
                ).to.equal(shares.mul(BN.from(2)));

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(2)));

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.sub(shares)
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender2.address,
                    0
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);
                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    0
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares.mul(BN.from(2)));

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address)
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(3)));
            });

            it("Should request redemption in the next epoch successfully", async function () {
                let shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                // console.log(`currentEpochId: ${currentEpochId}`);
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares)
                );

                let userRedemptionRequest =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                let epochId = await juniorTrancheVaultContract.epochIds(0);
                expect(epochId).to.equal(currentEpochId);
                let epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
                ).to.equal(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber()
                );
                await epochManagerContract.closeEpoch();
                currentEpochId = await epochManagerContract.currentEpochId();

                // Lender requests redemption in next epoch
                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares)
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    1
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                epochId = await juniorTrancheVaultContract.epochIds(1);
                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address)
                ).to.equal(shares);

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.sub(shares)
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender2.address,
                    0
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);
                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    1
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address)
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(2)));
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

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber()
                );
                await epochManagerContract.closeEpoch();

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

                // Lender removes redemption request
                shares = toToken(1000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                let userRedemptionRequestBefore =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                let epochBefore = await juniorTrancheVaultContract.epochMap(currentEpochId);
                let removableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                let userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                let epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);
                let removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.add(shares)
                );
                expect(userRedemptionRequestAfter.epochId).to.equal(currentEpochId);
                expect(
                    userRedemptionRequestBefore.shareRequested.sub(
                        userRedemptionRequestAfter.shareRequested
                    )
                ).to.equal(shares);
                expect(
                    epochBefore.totalShareRequested.sub(epochAfter.totalShareRequested)
                ).to.equal(shares);
                expect(
                    removableRedemptionSharesBefore.sub(removableRedemptionSharesAfter)
                ).to.equal(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber()
                );
                await epochManagerContract.closeEpoch();
                currentEpochId = await epochManagerContract.currentEpochId();

                // Lender and Lender2 add redemption requests
                shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

                // Lender removes redemption request
                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                epochBefore = await juniorTrancheVaultContract.epochMap(currentEpochId);
                removableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);
                removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 1);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.add(shares)
                );
                expect(
                    epochBefore.totalShareRequested.sub(epochAfter.totalShareRequested)
                ).to.equal(shares);
                expect(
                    removableRedemptionSharesBefore.sub(removableRedemptionSharesAfter)
                ).to.equal(shares);
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.shareRequested).to.equal(0);

                // Lender2 removes redemption request
                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                removableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).removeRedemptionRequest(shares)
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender2.address, shares, currentEpochId);
                removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender2.address, 0);
                epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);

                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.add(shares)
                );
                expect(
                    removableRedemptionSharesBefore.sub(removableRedemptionSharesAfter)
                ).to.equal(shares);
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.shareRequested).to.equal(0);
                checkEpochInfo(epochAfter, 0, 0);
            });
        });

        describe("Disburse Tests", function () {
            it("Should not disburse while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    juniorTrancheVaultContract.connect(lender).disburse(lender.address)
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    juniorTrancheVaultContract.connect(lender).disburse(lender.address)
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should disbuse while one epoch was fully processed", async function () {
                let shares = toToken(1000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await mineNextBlockWithTimestamp(ts);
                await epochManagerContract.closeEpoch();

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(shares);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(shares);

                let balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, lender.address, shares);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore.add(shares)
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address
                );
                checkUserDisburseInfo(disburseInfo, 1);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, shares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(shares)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 1);
            });

            it("Should disbuse while two epochs was fully processed", async function () {
                let shares = toToken(1000);
                let shares2 = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                let allShares = shares;
                let allShares2 = shares2;

                // Move all assets out of pool vault

                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(ethers.constants.HashZero, availableAssets);

                // Finish 1st epoch

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                shares = toToken(3000);
                shares2 = toToken(1500);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);
                allShares = allShares.add(shares);
                allShares2 = allShares2.add(shares2);

                // Move assets into pool vault for full processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    allShares.add(allShares2)
                );

                // Finish 2nd epoch

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(allShares);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(allShares2);

                let balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, allShares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(allShares)
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address
                );
                checkUserDisburseInfo(disburseInfo, 2);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, allShares2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(allShares2)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 2);
            });

            it("Should disbuse while epochs was partially processed", async function () {
                let shares = toToken(1000);
                let shares2 = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets out of pool vault for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(
                    ethers.constants.HashZero,
                    availableAssets.sub(availableAmount)
                );

                // Finish 1st epoch and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                let withdrawable = shares.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(withdrawable);
                let withdrawable2 = shares2.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(withdrawable2);

                let balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable)
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address
                );
                checkUserDisburseInfo(disburseInfo, 0, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 0, withdrawable2, withdrawable2);

                let withdrawableBefore = shares.sub(withdrawable);
                let withdrawableBefore2 = shares2.sub(withdrawable2);
                let gapAmount = shares.add(shares2).sub(availableAmount);

                shares = toToken(4000);
                shares2 = toToken(3000);
                availableAmount = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets into pool vault for partial processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    gapAmount.add(availableAmount)
                );

                // Finish 2nd epoch and process epoch1 fully and epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(withdrawable.add(withdrawableBefore));
                withdrawable2 = shares2.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(withdrawable2.add(withdrawableBefore2));

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(
                        lender.address,
                        defaultDeployer.address,
                        withdrawable.add(withdrawableBefore)
                    );
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable.add(withdrawableBefore))
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(disburseInfo, 1, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(
                        lender2.address,
                        lender2.address,
                        withdrawable2.add(withdrawableBefore2)
                    );
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2.add(withdrawableBefore2))
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 1, withdrawable2, withdrawable2);

                withdrawableBefore = withdrawable;
                withdrawableBefore2 = withdrawable2;
                let availableAmountBefore = availableAmount;
                availableAmount = toToken(3000).add(availableAmountBefore);

                // Move assets into pool vault for partial processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    availableAmount.sub(availableAmountBefore)
                );

                // Finish 3nd epoch and process epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares
                    .mul(availableAmount)
                    .div(shares.add(shares2))
                    .sub(withdrawableBefore);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(withdrawable);
                withdrawable2 = shares2
                    .mul(availableAmount)
                    .div(shares.add(shares2))
                    .sub(withdrawableBefore2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    (
                        await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                            lender.address
                        )
                    ).sub(BN.from(1)),
                    withdrawable.add(withdrawableBefore),
                    withdrawable.add(withdrawableBefore)
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    (
                        await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                            lender2.address
                        )
                    ).sub(BN.from(1)),
                    withdrawable2.add(withdrawableBefore2),
                    withdrawable2.add(withdrawableBefore2)
                );

                withdrawableBefore = shares.sub(withdrawable.add(withdrawableBefore));
                withdrawableBefore2 = shares2.sub(withdrawable2.add(withdrawableBefore2));
                gapAmount = shares.add(shares2).sub(availableAmount);

                shares = toToken(500);
                shares2 = toToken(800);
                availableAmount = shares.add(shares2);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets into pool vault for full processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    gapAmount.add(availableAmount)
                );

                // Finish 4th epoch and process epoch2 fully and epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares.add(withdrawableBefore);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address)
                ).to.equal(withdrawable);
                withdrawable2 = shares2.add(withdrawableBefore2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address)
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, lender.address, withdrawable);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore.add(withdrawable)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getUserRedemptionRequestLength(lender.address)
                );

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address)
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable2)
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender2.address
                    )
                );
            });
        });

        describe("Process Epochs Tests", function () {
            it("Should not allow non-EpochManager to process epochs", async function () {
                await expect(
                    juniorTrancheVaultContract.processEpochs([], 0, 0)
                ).to.be.revertedWithCustomError(poolConfigContract, "notEpochManager");
            });

            it("Should process one epochs fully", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address
                );
                let index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, shares, shares, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(shares)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(shares));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0
                );
                let epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares, shares, shares);
            });

            it("Should process multiple epochs fully", async function () {
                let shares = toToken(3000);
                let allShares = shares;
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Move all assets out of pool vault

                let availableAmount = toToken(0);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(
                    ethers.constants.HashZero,
                    availableAssets.sub(availableAmount)
                );

                // Close epoch1

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address
                );
                await epochManagerContract.closeEpoch();
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(totalSupply);
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1
                );
                let epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                let epochs = [];
                epochs.push(epoch);

                shares = toToken(756);
                allShares = allShares.add(shares);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Close epoch2

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                await epochManagerContract.closeEpoch();
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(totalSupply);
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2
                );
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(139);
                allShares = allShares.add(shares);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                await creditContract.makePayment(ethers.constants.HashZero, allShares);

                // Close epoch3

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                let index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, allShares, allShares, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(allShares)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(allShares));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0
                );
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                epochs.push(epoch);

                // check epochs fully processed
                for (let e of epochs) {
                    let en = await seniorTrancheVaultContract.epochMap(e.epochId);
                    checkEpochInfo(
                        en,
                        e.epochId,
                        e.totalShareRequested,
                        e.totalShareRequested,
                        e.totalShareRequested
                    );
                }
            });

            it("Should process one epochs partially", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Move assets out of pool vault for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(
                    ethers.constants.HashZero,
                    availableAssets.sub(availableAmount)
                );

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address
                );
                let index = (await seniorTrancheVaultContract.getRedemptionEpochLength()).sub(1);
                console.log(`index: ${index}`);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1
                );
                let epochId = await seniorTrancheVaultContract.epochIds(index);
                let epoch = await seniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, epochId, shares, availableAmount, availableAmount);
            });

            it("Should process multiple epochs partially", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Move assets out of pool vault for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(
                    ethers.constants.HashZero,
                    availableAssets.sub(availableAmount)
                );

                // Close epoch1 and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address
                );
                let index = (await seniorTrancheVaultContract.getRedemptionEpochLength()).sub(1);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1
                );
                let epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares, availableAmount, availableAmount);
                let epochs = [];
                epochs.push(epoch);

                shares = toToken(2000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmount = toToken(1000);
                await creditContract.makePayment(ethers.constants.HashZero, availableAmount);

                // Close epoch2 and process epoch1 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2
                );

                // epoch1
                let epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    availableAmount.add(epochOld.totalShareProcessed),
                    availableAmount.add(epochOld.totalAmountProcessed)
                );
                epochs[0] = epoch;

                // epoch2
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(846);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmount = toToken(1000);
                let availableAmountAll = epochs[0].totalShareRequested
                    .sub(epochs[0].totalShareProcessed)
                    .add(availableAmount);
                await creditContract.makePayment(ethers.constants.HashZero, availableAmountAll);

                // Close epoch3 and process epoch1 fully and epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                index = index.add(1);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(2, availableAmountAll, availableAmountAll, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmountAll)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(availableAmountAll));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2
                );

                // epoch1
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    epochOld.totalShareRequested,
                    epochOld.totalShareRequested
                );
                epochs.shift();

                // epoch2
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    availableAmount.add(epochOld.totalShareProcessed),
                    availableAmount.add(epochOld.totalAmountProcessed)
                );
                epochs[0] = epoch;

                // epoch3
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(2763);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmountAll = shares;
                for (let e of epochs) {
                    availableAmountAll = availableAmountAll.add(
                        e.totalShareRequested.sub(e.totalShareProcessed)
                    );
                }
                await creditContract.makePayment(ethers.constants.HashZero, availableAmountAll);

                // Close epoch4 and process epoch2, epoch3, epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, availableAmountAll, availableAmountAll, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmountAll)
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address)
                ).to.equal(balance.add(availableAmountAll));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0
                );

                // check epochs fully processed
                for (let e of epochs) {
                    let en = await seniorTrancheVaultContract.epochMap(e.epochId);
                    checkEpochInfo(
                        en,
                        e.epochId,
                        e.totalShareRequested,
                        e.totalShareRequested,
                        e.totalShareRequested
                    );
                }
            });
        });
    });
});
