import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { checkEpochInfo, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { mineNextBlockWithTimestamp, setNextBlockTimestamp, toToken } from "./TestUtils";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    HumaConfig,
    FirstLossCover,
    MockPoolCredit,
    MockToken,
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";

let defaultDeployer: HardhatEthersSigner,
    protocolOwner: HardhatEthersSigner,
    treasury: HardhatEthersSigner,
    eaServiceAccount: HardhatEthersSigner,
    pdsServiceAccount: HardhatEthersSigner;
let poolOwner: HardhatEthersSigner,
    poolOwnerTreasury: HardhatEthersSigner,
    evaluationAgent: HardhatEthersSigner,
    poolOperator: HardhatEthersSigner;
let lender: HardhatEthersSigner, lender2: HardhatEthersSigner;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    poolOwnerAndEAFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

function checkUserDisburseInfo(
    // TODO(jiatu): find a way to get rid of the `any`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    disburseInfo: any,
    requestsIndex: bigint | number,
    partialShareProcessed: bigint = 0n,
    partialAmountProcessed: bigint = 0n,
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
            poolOwner,
        );

        [
            poolConfigContract,
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            poolOwnerAndEAFirstLossCoverContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditFeeManagerContract,
            creditPnlManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, lender2],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("Operation Tests", function () {
        it("Should not allow non-Operator to add a lender", async function () {
            await expect(
                juniorTrancheVaultContract.addApprovedLender(defaultDeployer.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolOperatorRequired");
        });

        it("Should allow Operator to add a lender", async function () {
            let role = await poolConfigContract.POOL_OPERATOR_ROLE();
            await poolConfigContract.connect(poolOwner).grantRole(role, defaultDeployer.address);

            role = await juniorTrancheVaultContract.LENDER_ROLE();
            await expect(
                juniorTrancheVaultContract
                    .connect(defaultDeployer)
                    .addApprovedLender(defaultDeployer.address),
            )
                .to.emit(juniorTrancheVaultContract, "RoleGranted")
                .withArgs(role, defaultDeployer.address, defaultDeployer.address);

            expect(
                await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address),
            ).to.equal(true);
        });

        it("Should allow Operator to remove a lender", async function () {
            let role = await poolConfigContract.POOL_OPERATOR_ROLE();
            await poolConfigContract.connect(poolOwner).grantRole(role, defaultDeployer.address);
            await juniorTrancheVaultContract
                .connect(defaultDeployer)
                .addApprovedLender(defaultDeployer.address);

            role = await juniorTrancheVaultContract.LENDER_ROLE();
            await expect(
                juniorTrancheVaultContract
                    .connect(defaultDeployer)
                    .removeApprovedLender(defaultDeployer.address),
            )
                .to.emit(juniorTrancheVaultContract, "RoleRevoked")
                .withArgs(role, defaultDeployer.address, defaultDeployer.address);

            expect(
                await juniorTrancheVaultContract.hasRole(role, defaultDeployer.address),
            ).to.equal(false);
        });

        it("Should not allow non-Operator to remove a lender", async function () {
            await expect(
                juniorTrancheVaultContract.removeApprovedLender(defaultDeployer.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolOperatorRequired");
        });
    });

    describe("Depost Tests", function () {
        it("Should not deposit 0 amount", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(0, lender.address),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not input zero address receiver", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), ethers.ZeroAddress),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAddressProvided");
        });

        it("Should not allow non-Lender to deposit", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), lender.address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "permissionDeniedNotLender",
            );

            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(toToken(1), defaultDeployer.address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "permissionDeniedNotLender",
            );
        });

        it("Should not deposit while protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not deposit the amount exceeding cap", async function () {
            let lpConfig = await poolConfigContract.getLPConfig();
            await expect(
                juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(lpConfig.liquidityCap + 1n, lender.address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "exceededPoolLiquidityCap",
            );
        });

        it("Should not deposit while new senior total assets exceeds maxSeniorJuniorRatio", async function () {
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address),
            ).to.be.revertedWithCustomError(
                seniorTrancheVaultContract,
                "exceededMaxJuniorSeniorRatio",
            );
        });

        it("Should deposit successfully", async function () {
            let amount = toToken(40_000);
            let balanceBefore = await mockTokenContract.balanceOf(lender.address);
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(amount, lender.address),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender.address, amount, amount);

            expect(await poolContract.totalAssets()).to.equal(amount);
            const poolAssets = await poolContract.totalAssets();
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(amount);
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore - amount,
            );

            amount = toToken(10_000);
            balanceBefore = await mockTokenContract.balanceOf(lender.address);
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(amount, lender2.address),
            )
                .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender2.address, amount, amount);
            expect(await poolContract.totalAssets()).to.equal(poolAssets + amount);
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await seniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(amount);
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore - amount,
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
                    await juniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender.address,
                    ),
                ).to.equal(0);
            });

            it("Should not request 0 redemption", async function () {
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(0),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
            });

            it("Should not request redemption while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not request redemption greater than user's shares", async function () {
                const shares = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares + 1n),
                ).to.be.revertedWithCustomError(
                    juniorTrancheVaultContract,
                    "withdrawnAmountHigherThanBalance",
                );
            });

            it("Should request redemption in a same epoch successfully", async function () {
                let shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance - shares,
                );

                let userRedemptionRequest =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(shares);

                let epochId = await juniorTrancheVaultContract.epochIds(0);
                expect(epochId).to.equal(currentEpochId);
                let epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                // Lender requests redemption again

                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance - shares,
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    0,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares * 2n);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(shares * 2n);

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares * 2n);

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance - shares,
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender2.address,
                    0,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);
                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    0,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares * 2n);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address),
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares * 3n);
            });

            it("Should request redemption in the next epoch successfully", async function () {
                let shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance - shares,
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
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(currentEpoch.endTime + 60n * 5n);
                await epochManagerContract.closeEpoch();
                currentEpochId = await epochManagerContract.currentEpochId();

                // Lender requests redemption in next epoch
                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance - shares,
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    1,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                epochId = await juniorTrancheVaultContract.epochIds(1);
                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(shares);

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance - shares,
                );

                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender2.address,
                    0,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);
                userRedemptionRequest = await juniorTrancheVaultContract.userRedemptionRequests(
                    lender.address,
                    1,
                );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.shareRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address),
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochMap(epochId);
                checkEpochInfo(epoch, currentEpochId, shares * 2n);
            });

            it("Should get removable redemption shares correctly", async function () {
                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(0);
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                expect(
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address),
                ).to.equal(shares);
            });

            it("Should not remove 0 redemption request", async function () {
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(0),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
            });

            it("Should not remove redemption request while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not remove redemption request while no any redemption was requested", async function () {
                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "emptyArray");
            });

            it("Should not remove redemption request after requested epochs", async function () {
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(currentEpoch.endTime + 60n * 5n);
                await epochManagerContract.closeEpoch();

                await expect(
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(1),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "notCurrentEpoch");
            });

            it("Should not remove redemption request greater than requested shares", async function () {
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await expect(
                    juniorTrancheVaultContract
                        .connect(lender)
                        .removeRedemptionRequest(shares * 2n),
                ).to.be.revertedWithCustomError(
                    juniorTrancheVaultContract,
                    "shareHigherThanRequested",
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
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                let userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 0);
                let epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);
                let removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance + shares,
                );
                expect(userRedemptionRequestAfter.epochId).to.equal(currentEpochId);
                expect(
                    userRedemptionRequestBefore.shareRequested -
                        userRedemptionRequestAfter.shareRequested,
                ).to.equal(shares);
                expect(epochBefore.totalShareRequested - epochAfter.totalShareRequested).to.equal(
                    shares,
                );
                expect(removableRedemptionSharesBefore - removableRedemptionSharesAfter).to.equal(
                    shares,
                );

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(currentEpoch.endTime + 60n * 5n);
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
                    juniorTrancheVaultContract.connect(lender).removeRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);
                removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender.address, 1);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance + shares,
                );
                expect(epochBefore.totalShareRequested - epochAfter.totalShareRequested).to.equal(
                    shares,
                );
                expect(removableRedemptionSharesBefore - removableRedemptionSharesAfter).to.equal(
                    shares,
                );
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.shareRequested).to.equal(0);

                // Lender2 removes redemption request
                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                removableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).removeRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender2.address, shares, currentEpochId);
                removableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.removableRedemptionShares(lender2.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.userRedemptionRequests(lender2.address, 0);
                epochAfter = await juniorTrancheVaultContract.epochMap(currentEpochId);

                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance + shares,
                );
                expect(removableRedemptionSharesBefore - removableRedemptionSharesAfter).to.equal(
                    shares,
                );
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.shareRequested).to.equal(0);
                checkEpochInfo(epochAfter, 0n, 0n);
            });
        });

        describe("Disburse Tests", function () {
            it("Should not disburse while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    juniorTrancheVaultContract.connect(lender).disburse(lender.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    juniorTrancheVaultContract.connect(lender).disburse(lender.address),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should disbuse while one epoch was fully processed", async function () {
                let shares = toToken(1000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await mineNextBlockWithTimestamp(ts);
                await epochManagerContract.closeEpoch();

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(shares);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(shares);

                let balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, lender.address, shares);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore + shares,
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address,
                );
                checkUserDisburseInfo(disburseInfo, 1n);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, shares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + shares,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 1n);
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
                await creditContract.drawdown(ethers.ZeroHash, availableAssets);

                // Finish 1st epoch

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                shares = toToken(3000);
                shares2 = toToken(1500);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);
                allShares = allShares + shares;
                allShares2 = allShares2 + shares2;

                // Move assets into pool vault for full processing

                await creditContract.makePayment(ethers.ZeroHash, allShares + allShares2);

                // Finish 2nd epoch

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(allShares);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(allShares2);

                let balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, allShares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + allShares,
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address,
                );
                checkUserDisburseInfo(disburseInfo, 2n);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, allShares2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore + allShares2,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 2n);
            });

            it("Should disbuse while epochs was partially processed", async function () {
                let shares = toToken(1000);
                let shares2 = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets out of pool vault for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(ethers.ZeroHash, availableAssets - availableAmount);

                // Finish 1st epoch and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                let withdrawable = (shares * availableAmount) / (shares + shares2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                let withdrawable2 = (shares2 * availableAmount) / (shares + shares2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                let balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + withdrawable,
                );
                let disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(
                    lender.address,
                );
                checkUserDisburseInfo(disburseInfo, 0, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore + withdrawable2,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 0, withdrawable2, withdrawable2);

                let withdrawableBefore = shares - withdrawable;
                let withdrawableBefore2 = shares2 - withdrawable2;
                let gapAmount = shares + shares2 - availableAmount;

                shares = toToken(4000);
                shares2 = toToken(3000);
                availableAmount = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets into pool vault for partial processing

                await creditContract.makePayment(ethers.ZeroHash, gapAmount + availableAmount);

                // Finish 2nd epoch and process epoch1 fully and epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = (shares * availableAmount) / (shares + shares2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable + withdrawableBefore);
                withdrawable2 = (shares2 * availableAmount) / (shares + shares2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2 + withdrawableBefore2);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(
                        lender.address,
                        defaultDeployer.address,
                        withdrawable + withdrawableBefore,
                    );
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + withdrawable + withdrawableBefore,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(disburseInfo, 1, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(
                        lender2.address,
                        lender2.address,
                        withdrawable2 + withdrawableBefore2,
                    );
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore + withdrawable2 + withdrawableBefore2,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(disburseInfo, 1, withdrawable2, withdrawable2);

                withdrawableBefore = withdrawable;
                withdrawableBefore2 = withdrawable2;
                let availableAmountBefore = availableAmount;
                availableAmount = toToken(3000) + availableAmountBefore;

                // Move assets into pool vault for partial processing

                await creditContract.makePayment(
                    ethers.ZeroHash,
                    availableAmount - availableAmountBefore,
                );

                // Finish 3rd epoch and process epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable =
                    (shares * availableAmount) / (shares + shares2) - withdrawableBefore;
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                withdrawable2 =
                    (shares2 * availableAmount) / (shares + shares2) - withdrawableBefore2;
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + withdrawable,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    (await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender.address,
                    )) - 1n,
                    withdrawable + withdrawableBefore,
                    withdrawable + withdrawableBefore,
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore + withdrawable2,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    (await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender2.address,
                    )) - 1n,
                    withdrawable2 + withdrawableBefore2,
                    withdrawable2 + withdrawableBefore2,
                );

                withdrawableBefore = shares - (withdrawable + withdrawableBefore);
                withdrawableBefore2 = shares2 - (withdrawable2 + withdrawableBefore2);
                gapAmount = shares + shares2 - availableAmount;

                shares = toToken(500);
                shares2 = toToken(800);
                availableAmount = shares + shares2;

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets into pool vault for full processing

                await creditContract.makePayment(ethers.ZeroHash, gapAmount + availableAmount);

                // Finish 4th epoch and process epoch2 fully and epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares + withdrawableBefore;
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                withdrawable2 = shares2 + withdrawableBefore2;
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender.address, lender.address, withdrawable);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore + withdrawable,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender.address,
                    ),
                );

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "UserDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore + withdrawable2,
                );
                disburseInfo = await seniorTrancheVaultContract.userDisburseInfos(lender2.address);
                checkUserDisburseInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getUserRedemptionRequestLength(
                        lender2.address,
                    ),
                );
            });
        });

        describe("Process Epochs Tests", function () {
            it("Should not allow non-EpochManager to process epochs", async function () {
                await expect(
                    juniorTrancheVaultContract.processEpochs([], 0, 0),
                ).to.be.revertedWithCustomError(poolConfigContract, "notEpochManager");
            });

            it("Should process one epochs fully", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                let index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, shares, shares, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - shares,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + shares);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
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
                await creditContract.drawdown(ethers.ZeroHash, availableAssets - availableAmount);

                // Close epoch1

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                await epochManagerContract.closeEpoch();
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(totalSupply);
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                let epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                let epochs = [];
                epochs.push(epoch);

                shares = toToken(756);
                allShares = allShares + shares;
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Close epoch2

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                await epochManagerContract.closeEpoch();
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(totalSupply);
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(139);
                allShares = allShares + shares;
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                await creditContract.makePayment(ethers.ZeroHash, allShares);

                // Close epoch3

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                let index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, allShares, allShares, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - allShares,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + allShares);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
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
                        e.totalShareRequested,
                    );
                }
            });

            it("Should process one epochs partially", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Move assets out of pool vault for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolVaultContract.totalAssets();
                await creditContract.drawdown(ethers.ZeroHash, availableAssets - availableAmount);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                let index = (await seniorTrancheVaultContract.getRedemptionEpochLength()) - 1n;
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - availableAmount,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + availableAmount);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
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
                await creditContract.drawdown(ethers.ZeroHash, availableAssets - availableAmount);

                // Close epoch1 and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                let index = (await seniorTrancheVaultContract.getRedemptionEpochLength()) - 1n;
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - availableAmount,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + availableAmount);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                let epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares, availableAmount, availableAmount);
                let epochs = [];
                epochs.push(epoch);

                shares = toToken(2000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmount = toToken(1000);
                await creditContract.makePayment(ethers.ZeroHash, availableAmount);

                // Close epoch2 and process epoch1 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - availableAmount,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + availableAmount);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );

                // epoch1
                let epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    availableAmount + epochOld.totalShareProcessed,
                    availableAmount + epochOld.totalAmountProcessed,
                );
                epochs[0] = epoch;

                // epoch2
                epoch = await seniorTrancheVaultContract.epochMap(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(846);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmount = toToken(1000);
                let availableAmountAll =
                    epochs[0].totalShareRequested -
                    epochs[0].totalShareProcessed +
                    availableAmount;
                await creditContract.makePayment(ethers.ZeroHash, availableAmountAll);

                // Close epoch3 and process epoch1 fully and epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                index = index + 1n;
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(2, availableAmountAll, availableAmountAll, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - availableAmountAll,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + availableAmountAll);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );

                // epoch1
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    epochOld.totalShareRequested,
                    epochOld.totalShareRequested,
                );
                epochs.shift();

                // epoch2
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochMap(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalShareRequested,
                    availableAmount + epochOld.totalShareProcessed,
                    availableAmount + epochOld.totalAmountProcessed,
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
                    availableAmountAll =
                        availableAmountAll + e.totalShareRequested - e.totalShareProcessed;
                }
                await creditContract.makePayment(ethers.ZeroHash, availableAmountAll);

                // Close epoch4 and process epoch2, epoch3, epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime + 60n * 5n;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.getAddress(),
                );
                index = await seniorTrancheVaultContract.getRedemptionEpochLength();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, availableAmountAll, availableAmountAll, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply - availableAmountAll,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.getAddress()),
                ).to.equal(balance + availableAmountAll);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );

                // check epochs fully processed
                for (let e of epochs) {
                    let en = await seniorTrancheVaultContract.epochMap(e.epochId);
                    checkEpochInfo(
                        en,
                        e.epochId,
                        e.totalShareRequested,
                        e.totalShareRequested,
                        e.totalShareRequested,
                    );
                }
            });
        });
    });
});
