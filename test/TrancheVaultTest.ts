import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { checkEpochInfo, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { mineNextBlockWithTimestamp, setNextBlockTimestamp, toToken } from "./TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, lender2: SignerWithAddress;

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

function checkRedemptionDisbursementInfo(
    // TODO(jiatu): find a way to get rid of the `any`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    disburseInfo: any,
    requestsIndex: BN | number,
    actualSharesProcessed: BN = BN.from(0),
    actualAmountProcessed: BN = BN.from(0),
) {
    expect(disburseInfo.requestsIndex).to.equal(requestsIndex);
    expect(disburseInfo.actualSharesProcessed).to.equal(actualSharesProcessed);
    expect(disburseInfo.actualAmountProcessed).to.equal(actualAmountProcessed);
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

        it("Should not allow non-Operator to remove a lender", async function () {
            await expect(
                juniorTrancheVaultContract.removeApprovedLender(defaultDeployer.address),
            ).to.be.revertedWithCustomError(poolConfigContract, "poolOperatorRequired");
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
    });

    describe("Deposit Tests", function () {
        it("Should not deposit 0 amount", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(0, lender.address),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not input zero address receiver", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), ethers.constants.AddressZero),
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
                    .deposit(lpConfig.liquidityCap.add(BN.from(1)), lender.address),
            ).to.be.revertedWithCustomError(
                juniorTrancheVaultContract,
                "poolLiquidityCapExceeded",
            );
        });

        it("Should not deposit while new senior total assets exceeds maxSeniorJuniorRatio", async function () {
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(toToken(1), lender.address),
            ).to.be.revertedWithCustomError(
                seniorTrancheVaultContract,
                "maxSeniorJuniorRatioExceeded",
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
            let poolAssets = await poolContract.totalAssets();
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(amount);
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore.sub(amount),
            );

            amount = toToken(10_000);
            balanceBefore = await mockTokenContract.balanceOf(lender.address);
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(amount, lender2.address),
            )
                .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender2.address, amount, amount);
            expect(await poolContract.totalAssets()).to.equal(poolAssets.add(amount));
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(amount);
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(amount);
            expect(await seniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(amount);
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                balanceBefore.sub(amount),
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
            it("Should call getNumEpochsWithRedemption to return 0", async function () {
                expect(await juniorTrancheVaultContract.getNumEpochsWithRedemption()).to.equal(0);
            });

            it("Should call getNumRedemptionRequests to return 0", async function () {
                expect(
                    await juniorTrancheVaultContract.getNumRedemptionRequests(lender.address),
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
                let shares = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract
                        .connect(lender)
                        .addRedemptionRequest(shares.add(BN.from(1))),
                ).to.be.revertedWithCustomError(
                    juniorTrancheVaultContract,
                    "withdrawnAmountHigherThanBalance",
                );
            });

            it("Should request redemption in a same epoch successfully", async function () {
                let shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                // console.log(`currentEpochId: ${currentEpochId}`);
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares),
                );

                let userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(shares);

                let epochId = await juniorTrancheVaultContract.epochIds(0);
                expect(epochId).to.equal(currentEpochId);
                let epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                // Lender requests redemption again

                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares),
                );

                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares.mul(BN.from(2)));

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(shares.mul(BN.from(2)));

                epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(2)));

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.sub(shares),
                );

                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(
                        lender2.address,
                        0,
                    );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);
                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares.mul(BN.from(2)));

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender2.address),
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(3)));
            });

            it("Should request redemption in the next epoch successfully", async function () {
                const shares = toToken(10_000);
                let currentEpochId = await epochManagerContract.currentEpochId();
                // console.log(`currentEpochId: ${currentEpochId}`);
                let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.sub(shares),
                );

                let userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);

                let epochId = await juniorTrancheVaultContract.epochIds(0);
                expect(epochId).to.equal(currentEpochId);
                let epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber(),
                );
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
                    balance.sub(shares),
                );

                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 1);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);

                epochId = await juniorTrancheVaultContract.epochIds(1);
                epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares);

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(shares);

                // Lender2 requests redemption

                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                    .withArgs(lender2.address, shares, currentEpochId);
                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.sub(shares),
                );

                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(
                        lender2.address,
                        0,
                    );
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);
                userRedemptionRequest =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 1);
                expect(userRedemptionRequest.epochId).to.equal(currentEpochId);
                expect(userRedemptionRequest.numSharesRequested).to.equal(shares);

                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender2.address),
                ).to.equal(shares);

                epoch = await juniorTrancheVaultContract.epochInfoByEpochId(epochId);
                checkEpochInfo(epoch, currentEpochId, shares.mul(BN.from(2)));
            });

            it("Should get removable redemption shares correctly", async function () {
                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(0);
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                expect(
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address),
                ).to.equal(shares);
            });

            it("Should not remove 0 redemption request", async function () {
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(0),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
            });

            it("Should not remove redemption request while protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(1),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not remove redemption request while no any redemption was requested", async function () {
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(1),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "emptyArray");
            });

            it("Should not remove redemption request after requested epochs", async function () {
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber(),
                );
                await epochManagerContract.closeEpoch();

                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(1),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "notCurrentEpoch");
            });

            it("Should not remove redemption request greater than requested shares", async function () {
                let shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await expect(
                    juniorTrancheVaultContract
                        .connect(lender)
                        .cancelRedemptionRequest(shares.mul(BN.from(2))),
                ).to.be.revertedWithCustomError(
                    juniorTrancheVaultContract,
                    "insufficientSharesForRequest",
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
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                let epochBefore =
                    await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                let cancellableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                let userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 0);
                let epochAfter =
                    await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                let cancellableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.add(shares),
                );
                expect(userRedemptionRequestAfter.epochId).to.equal(currentEpochId);
                expect(
                    userRedemptionRequestBefore.numSharesRequested.sub(
                        userRedemptionRequestAfter.numSharesRequested,
                    ),
                ).to.equal(shares);
                expect(
                    epochBefore.totalSharesRequested.sub(epochAfter.totalSharesRequested),
                ).to.equal(shares);
                expect(
                    cancellableRedemptionSharesBefore.sub(cancellableRedemptionSharesAfter),
                ).to.equal(shares);

                // Close current epoch
                let currentEpoch = await epochManagerContract.currentEpoch();
                await mineNextBlockWithTimestamp(
                    currentEpoch.endTime.add(BN.from(60 * 5)).toNumber(),
                );
                await epochManagerContract.closeEpoch();
                currentEpochId = await epochManagerContract.currentEpochId();

                // Lender and Lender2 add redemption requests
                shares = toToken(10_000);
                await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares);

                // Lender removes redemption request
                balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                epochBefore = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                cancellableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender.address, shares, currentEpochId);
                epochAfter = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                cancellableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(lender.address, 1);

                expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                    balance.add(shares),
                );
                expect(
                    epochBefore.totalSharesRequested.sub(epochAfter.totalSharesRequested),
                ).to.equal(shares);
                expect(
                    cancellableRedemptionSharesBefore.sub(cancellableRedemptionSharesAfter),
                ).to.equal(shares);
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.numSharesRequested).to.equal(0);

                // Lender2 removes redemption request
                balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                cancellableRedemptionSharesBefore =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender2.address);
                await expect(
                    juniorTrancheVaultContract.connect(lender2).cancelRedemptionRequest(shares),
                )
                    .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                    .withArgs(lender2.address, shares, currentEpochId);
                cancellableRedemptionSharesAfter =
                    await juniorTrancheVaultContract.cancellableRedemptionShares(lender2.address);
                userRedemptionRequestAfter =
                    await juniorTrancheVaultContract.redemptionRequestsByLender(
                        lender2.address,
                        0,
                    );
                epochAfter = await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);

                expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                    balance.add(shares),
                );
                expect(
                    cancellableRedemptionSharesBefore.sub(cancellableRedemptionSharesAfter),
                ).to.equal(shares);
                expect(userRedemptionRequestAfter.epochId).to.equal(0);
                expect(userRedemptionRequestAfter.numSharesRequested).to.equal(0);
                checkEpochInfo(epochAfter, BN.from(0), BN.from(0));
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
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
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
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, lender.address, shares);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore.add(shares),
                );
                let disburseInfo =
                    await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                        lender.address,
                    );
                checkRedemptionDisbursementInfo(disburseInfo, 1);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, shares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(shares),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(disburseInfo, 1);
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
                    allShares.add(allShares2),
                );

                // Finish 2nd epoch

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
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
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, allShares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(allShares),
                );
                let disburseInfo =
                    await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                        lender.address,
                    );
                checkRedemptionDisbursementInfo(disburseInfo, 2);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, lender2.address, allShares2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(allShares2),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(disburseInfo, 2);
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
                    availableAssets.sub(availableAmount),
                );

                // Finish 1st epoch and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                let withdrawable = shares.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                let withdrawable2 = shares2.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                let balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable),
                );
                let disburseInfo =
                    await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                        lender.address,
                    );
                checkRedemptionDisbursementInfo(disburseInfo, 0, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(disburseInfo, 0, withdrawable2, withdrawable2);

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
                    gapAmount.add(availableAmount),
                );

                // Finish 2nd epoch and process epoch1 fully and epoch2 partially

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable.add(withdrawableBefore));
                withdrawable2 = shares2.mul(availableAmount).div(shares.add(shares2));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2.add(withdrawableBefore2));

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(
                        lender.address,
                        defaultDeployer.address,
                        withdrawable.add(withdrawableBefore),
                    );
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable.add(withdrawableBefore)),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender.address,
                );
                checkRedemptionDisbursementInfo(disburseInfo, 1, withdrawable, withdrawable);

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(
                        lender2.address,
                        lender2.address,
                        withdrawable2.add(withdrawableBefore2),
                    );
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2.add(withdrawableBefore2)),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(disburseInfo, 1, withdrawable2, withdrawable2);

                withdrawableBefore = withdrawable;
                withdrawableBefore2 = withdrawable2;
                let availableAmountBefore = availableAmount;
                availableAmount = toToken(3000).add(availableAmountBefore);

                // Move assets into pool vault for partial processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    availableAmount.sub(availableAmountBefore),
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
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                withdrawable2 = shares2
                    .mul(availableAmount)
                    .div(shares.add(shares2))
                    .sub(withdrawableBefore2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, defaultDeployer.address, withdrawable);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender.address,
                );
                checkRedemptionDisbursementInfo(
                    disburseInfo,
                    (
                        await seniorTrancheVaultContract.getNumRedemptionRequests(lender.address)
                    ).sub(BN.from(1)),
                    withdrawable.add(withdrawableBefore),
                    withdrawable.add(withdrawableBefore),
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(
                    disburseInfo,
                    (
                        await seniorTrancheVaultContract.getNumRedemptionRequests(lender2.address)
                    ).sub(BN.from(1)),
                    withdrawable2.add(withdrawableBefore2),
                    withdrawable2.add(withdrawableBefore2),
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
                    gapAmount.add(availableAmount),
                );

                // Finish 4th epoch and process epoch2 fully and epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = shares.add(withdrawableBefore);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                withdrawable2 = shares2.add(withdrawableBefore2);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(withdrawable2);

                balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, lender.address, withdrawable);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore.add(withdrawable),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender.address,
                );
                checkRedemptionDisbursementInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getNumRedemptionRequests(lender.address),
                );

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(withdrawable2),
                );
                disburseInfo = await seniorTrancheVaultContract.redemptionDisbursementInfoByLender(
                    lender2.address,
                );
                checkRedemptionDisbursementInfo(
                    disburseInfo,
                    await seniorTrancheVaultContract.getNumRedemptionRequests(lender2.address),
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
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );
                let index = await seniorTrancheVaultContract.getNumEpochsWithRedemption();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, shares, shares, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(shares),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(shares));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                let epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
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
                    availableAssets.sub(availableAmount),
                );

                // Close epoch1

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );
                await epochManagerContract.closeEpoch();
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(totalSupply);
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                let epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
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
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance);
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
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
                let index = await seniorTrancheVaultContract.getNumEpochsWithRedemption();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, allShares, allShares, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(allShares),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(allShares));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
                epochs.push(epoch);

                // check epochs fully processed
                for (let e of epochs) {
                    let en = await seniorTrancheVaultContract.epochInfoByEpochId(e.epochId);
                    checkEpochInfo(
                        en,
                        e.epochId,
                        e.totalSharesRequested,
                        e.totalSharesRequested,
                        e.totalSharesRequested,
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
                    availableAssets.sub(availableAmount),
                );

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );
                let index = (await seniorTrancheVaultContract.getNumEpochsWithRedemption()).sub(1);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                let epochId = await seniorTrancheVaultContract.epochIds(index);
                let epoch = await seniorTrancheVaultContract.epochInfoByEpochId(epochId);
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
                    availableAssets.sub(availableAmount),
                );

                // Close epoch1 and process epoch1 partially

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );
                let index = (await seniorTrancheVaultContract.getNumEpochsWithRedemption()).sub(1);
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(1, availableAmount, availableAmount, index);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    1,
                );
                let epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
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
                    totalSupply.sub(availableAmount),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmount));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );

                // epoch1
                let epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalSharesRequested,
                    availableAmount.add(epochOld.totalSharesProcessed),
                    availableAmount.add(epochOld.totalAmountProcessed),
                );
                epochs[0] = epoch;

                // epoch2
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(846);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmount = toToken(1000);
                let availableAmountAll = epochs[0].totalSharesRequested
                    .sub(epochs[0].totalSharesProcessed)
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
                    totalSupply.sub(availableAmountAll),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmountAll));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    2,
                );

                // epoch1
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalSharesRequested,
                    epochOld.totalSharesRequested,
                    epochOld.totalSharesRequested,
                );
                epochs.shift();

                // epoch2
                epochOld = epochs[0];
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(epochOld.epochId);
                checkEpochInfo(
                    epoch,
                    epochOld.epochId,
                    epochOld.totalSharesRequested,
                    availableAmount.add(epochOld.totalSharesProcessed),
                    availableAmount.add(epochOld.totalAmountProcessed),
                );
                epochs[0] = epoch;

                // epoch3
                epoch = await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id);
                checkEpochInfo(epoch, lastEpoch.id, shares);
                epochs.push(epoch);

                shares = toToken(2763);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                availableAmountAll = shares;
                for (let e of epochs) {
                    availableAmountAll = availableAmountAll.add(
                        e.totalSharesRequested.sub(e.totalSharesProcessed),
                    );
                }
                await creditContract.makePayment(ethers.constants.HashZero, availableAmountAll);

                // Close epoch4 and process epoch2, epoch3, epoch4 fully

                lastEpoch = await epochManagerContract.currentEpoch();
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                totalSupply = await seniorTrancheVaultContract.totalSupply();
                balance = await mockTokenContract.balanceOf(seniorTrancheVaultContract.address);
                index = await seniorTrancheVaultContract.getNumEpochsWithRedemption();
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochsProcessed")
                    .withArgs(3, availableAmountAll, availableAmountAll, index);
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmountAll),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmountAll));
                expect((await seniorTrancheVaultContract.unprocessedEpochInfos()).length).to.equal(
                    0,
                );

                // check epochs fully processed
                for (let e of epochs) {
                    let en = await seniorTrancheVaultContract.epochInfoByEpochId(e.epochId);
                    checkEpochInfo(
                        en,
                        e.epochId,
                        e.totalSharesRequested,
                        e.totalSharesRequested,
                        e.totalSharesRequested,
                    );
                }
            });
        });
    });
});
