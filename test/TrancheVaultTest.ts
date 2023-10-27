import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditFeeManager,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
    MockPoolCredit,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    ProfitEscrow,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import {
    CONSTANTS,
    EpochChecker,
    PnLCalculator,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "./BaseTest";
import {
    getFirstLossCoverInfo,
    mineNextBlockWithTimestamp,
    overrideLPConfig,
    setNextBlockTimestamp,
    toToken,
} from "./TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress,
    lender2: SignerWithAddress,
    lender3: SignerWithAddress,
    lender4: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: CreditFeeManager;

let epochChecker: EpochChecker;

async function checkRedemptionDisbursementInfoByLender(
    trancheVaultContract: TrancheVault,
    lender: SignerWithAddress,
    indexOfEpochIds: BN | number,
    numSharesRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    const redemptionInfo = await trancheVaultContract.redemptionInfoByLender(lender.address);
    checkRedemptionInfo(
        redemptionInfo,
        indexOfEpochIds,
        numSharesRequested,
        totalAmountProcessed,
        totalAmountWithdrawn,
        delta,
    );
}

function checkRedemptionInfo(
    // TODO(jiatu): find a way to get rid of the `any`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redemptionInfo: any,
    indexOfEpochIds: BN | number,
    numSharesRequested: BN = BN.from(0),
    totalAmountProcessed: BN = BN.from(0),
    totalAmountWithdrawn: BN = BN.from(0),
    delta: number = 0,
) {
    expect(redemptionInfo.indexOfEpochIds).to.be.closeTo(indexOfEpochIds, delta);
    expect(redemptionInfo.numSharesRequested).to.be.closeTo(numSharesRequested, delta);
    expect(redemptionInfo.totalAmountProcessed).to.be.closeTo(totalAmountProcessed, delta);
    expect(redemptionInfo.totalAmountWithdrawn).to.be.closeTo(totalAmountWithdrawn, delta);
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
            lender3,
            lender4,
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
            poolFeeManagerContract,
            poolSafeContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditFeeManagerContract,
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
            [lender, lender2, lender3, lender4, poolOwnerTreasury, evaluationAgent],
        );

        epochChecker = new EpochChecker(
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
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

    describe("makeInitialDeposit", function () {
        it("Should allow the pool owner treasury to make the initial deposit even if the protocol is paused or the pool is off", async function () {
            const amount = toToken(1);
            const shares = amount;
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(poolOwnerTreasury).makeInitialDeposit(amount),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(poolOwnerTreasury.address, amount, shares);
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(poolOwnerTreasury).makeInitialDeposit(amount),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(poolOwnerTreasury.address, amount, shares);
        });

        it("Should allow the EA to make the initial deposit even if the protocol is paused or the pool is off", async function () {
            const amount = toToken(1);
            const shares = amount;
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                juniorTrancheVaultContract.connect(evaluationAgent).makeInitialDeposit(amount),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(evaluationAgent.address, amount, shares);
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                juniorTrancheVaultContract.connect(evaluationAgent).makeInitialDeposit(amount),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(evaluationAgent.address, amount, shares);
        });

        it("Should now allow anyone else to make the initial deposit", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).makeInitialDeposit(toToken(1)),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "notAuthorizedCaller");
        });
    });

    describe("Deposit Tests", function () {
        it("Should not allow deposits with 0 amount", async function () {
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(0, lender.address),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAmountProvided");
        });

        it("Should not allow the receiver address to be 0", async function () {
            await expect(
                juniorTrancheVaultContract.deposit(toToken(1), ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "zeroAddressProvided");
        });

        it("Should not allow a non-Lender to deposit", async function () {
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

        it("Should not allow deposits when the protocol is paused or the pool is off", async function () {
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

        it("Should not allow deposits that would result in the liquidity cap being exceeded", async function () {
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

        it("Should not allow deposits if the new senior total assets would exceed the maxSeniorJuniorRatio", async function () {
            const lpConfig = await poolConfigContract.getLPConfig();
            const juniorAssets = await juniorTrancheVaultContract.totalAssets();
            const seniorDepositAmount = juniorAssets.mul(lpConfig.maxSeniorJuniorRatio).add(1);
            await expect(
                seniorTrancheVaultContract
                    .connect(lender)
                    .deposit(seniorDepositAmount, lender.address),
            ).to.be.revertedWithCustomError(
                seniorTrancheVaultContract,
                "maxSeniorJuniorRatioExceeded",
            );
        });

        it("Should allow lenders to deposit", async function () {
            const juniorAmount = toToken(40_000);
            const existingJuniorAssets = await juniorTrancheVaultContract.totalAssets();
            const existingJuniorShares = await juniorTrancheVaultContract.totalSupply();
            const juniorShares = juniorAmount.mul(existingJuniorShares).div(existingJuniorAssets);
            const lenderBalanceBeforeJuniorDeposit = await mockTokenContract.balanceOf(
                lender.address,
            );
            await expect(
                juniorTrancheVaultContract.connect(lender).deposit(juniorAmount, lender.address),
            )
                .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender.address, juniorAmount, juniorShares);

            expect(await poolContract.totalAssets()).to.equal(
                existingJuniorAssets.add(juniorAmount),
            );
            const poolAssets = await poolContract.totalAssets();
            expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                existingJuniorAssets.add(juniorAmount),
            );
            expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                existingJuniorShares.add(juniorShares),
            );
            expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                juniorShares,
            );
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                lenderBalanceBeforeJuniorDeposit.sub(juniorAmount),
            );

            const seniorAmount = toToken(10_000);
            const lenderBalanceBeforeSeniorDeposit = await mockTokenContract.balanceOf(
                lender.address,
            );
            // Let lender makes the deposit, but send the token to lender2.
            await expect(
                seniorTrancheVaultContract.connect(lender).deposit(seniorAmount, lender2.address),
            )
                .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                .withArgs(lender2.address, seniorAmount, seniorAmount);
            expect(await poolContract.totalAssets()).to.equal(poolAssets.add(seniorAmount));
            expect(await seniorTrancheVaultContract.totalAssets()).to.equal(seniorAmount);
            expect(await seniorTrancheVaultContract.totalSupply()).to.equal(seniorAmount);
            expect(await seniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                seniorAmount,
            );
            expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                lenderBalanceBeforeSeniorDeposit.sub(seniorAmount),
            );
        });

        describe("When there is PnL", function () {
            let juniorAmount: BN, seniorAmount: BN;

            before(function () {
                juniorAmount = toToken(20_000);
                seniorAmount = toToken(5_000);
            });

            async function testDepositWithPnL(profit: BN, loss: BN, lossRecovery: BN) {
                // Have lenders make some initial deposits into the junior and senior tranches.
                await juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(juniorAmount, lender.address);
                await seniorTrancheVaultContract
                    .connect(lender2)
                    .deposit(seniorAmount, lender2.address);
                const initialJuniorShares = await juniorTrancheVaultContract.totalSupply();
                const initialSeniorShares = await seniorTrancheVaultContract.totalSupply();

                // Distribute profit, loss and loss recovery in the pool so that LP tokens changes in value.
                await creditContract.setRefreshPnLReturns(profit, loss, lossRecovery);
                await poolConfigContract
                    .connect(poolOwner)
                    .setEpochManager(defaultDeployer.address);
                const adjustment = 8000;
                await overrideLPConfig(poolConfigContract, poolOwner, {
                    tranchesRiskAdjustmentInBps: adjustment,
                });

                const assetInfo = await poolContract.tranchesAssets();
                const assets = [
                    assetInfo[CONSTANTS.SENIOR_TRANCHE],
                    assetInfo[CONSTANTS.JUNIOR_TRANCHE],
                ];
                const profitAfterFees =
                    await poolFeeManagerContract.calcPoolFeeDistribution(profit);
                const firstLossCoverInfos = await Promise.all(
                    [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map(
                        async (contract) =>
                            await getFirstLossCoverInfo(contract, poolConfigContract),
                    ),
                );
                const [[seniorAssets, juniorAssets]] =
                    await PnLCalculator.calcRiskAdjustedProfitAndLoss(
                        profitAfterFees,
                        loss,
                        lossRecovery,
                        assets,
                        BN.from(adjustment),
                        firstLossCoverInfos,
                    );

                // Make a second round of deposits to make sure the LP token price has increased
                // and the correct number of tokens are minted.
                // First check the junior tranche.
                const expectedJuniorAssets = juniorAssets.add(juniorAmount);
                const expectedNewJuniorShares = juniorAmount
                    .mul(initialJuniorShares)
                    .div(juniorAssets);
                await expect(
                    juniorTrancheVaultContract
                        .connect(lender3)
                        .deposit(juniorAmount, lender3.address),
                )
                    .to.emit(juniorTrancheVaultContract, "LiquidityDeposited")
                    .withArgs(lender3.address, juniorAmount, expectedNewJuniorShares);
                const poolAssets = await poolContract.totalAssets();
                expect(poolAssets).to.equal(expectedJuniorAssets.add(seniorAssets));
                expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                    expectedJuniorAssets,
                );
                // Check junior LP token.
                expect(await juniorTrancheVaultContract.totalSupply()).to.equal(
                    expectedNewJuniorShares.add(initialJuniorShares),
                );
                expect(await juniorTrancheVaultContract.balanceOf(lender3.address)).to.equal(
                    expectedNewJuniorShares,
                );

                // Then check the senior tranche.
                const expectedSeniorAssets = seniorAssets.add(seniorAmount);
                const expectedNewSeniorShares = seniorAmount
                    .mul(initialSeniorShares)
                    .div(seniorAssets);
                await expect(
                    seniorTrancheVaultContract
                        .connect(lender4)
                        .deposit(seniorAmount, lender4.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LiquidityDeposited")
                    .withArgs(lender4.address, seniorAmount, expectedNewSeniorShares);
                expect(await poolContract.totalAssets()).to.equal(poolAssets.add(seniorAmount));
                expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                    expectedSeniorAssets,
                );
                // Check senior LP token.
                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    expectedNewSeniorShares.add(initialSeniorShares),
                );
                expect(await seniorTrancheVaultContract.balanceOf(lender4.address)).to.equal(
                    expectedNewSeniorShares,
                );
            }

            it("Should mint the correct number of LP tokens if there is profit in the pool", async function () {
                const profit = toToken(10_000),
                    loss = toToken(0),
                    lossRecovery = toToken(0);
                await testDepositWithPnL(profit, loss, lossRecovery);
            });

            it("Should mint the correct number of LP tokens if the junior tranche has to take loss", async function () {
                const profit = toToken(0),
                    loss = juniorAmount.sub(toToken(1)),
                    lossRecovery = toToken(0);
                await testDepositWithPnL(profit, loss, lossRecovery);
            });

            // TODO(jiatu): re-enable this test after we figure out what we should do if totalAssets == 0
            // when converting assets to shares.
            // it("Should mint the correct number of LP tokens if the senior tranche has to take loss", async function () {
            //     const profit = toToken(0), loss = juniorAmount.add(seniorAmount), lossRecovery = toToken(0);
            //     await testDepositWithPnL(profit, loss, lossRecovery);
            // });

            it("Should mint the correct number of LP tokens if the senior tranche loss can be recovered", async function () {
                const profit = toToken(0),
                    loss = juniorAmount.add(seniorAmount),
                    lossRecovery = seniorAmount.add(toToken(1));
                await testDepositWithPnL(profit, loss, lossRecovery);
            });

            it("Should mint the correct number of LP tokens if the junior tranche loss can be recovered", async function () {
                const profit = toToken(0),
                    loss = juniorAmount.add(seniorAmount),
                    lossRecovery = seniorAmount.add(juniorAmount);
                await testDepositWithPnL(profit, loss, lossRecovery);
            });

            it("Should mint the correct number of LP tokens if there is all types of PnL in the pool", async function () {
                const profit = toToken(10_000),
                    loss = toToken(1_000),
                    lossRecovery = toToken(500);
                await testDepositWithPnL(profit, loss, lossRecovery);
            });
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
            describe("When there is no redemption request", function () {
                it("getNumEpochsWithRedemption should return 0", async function () {
                    expect(await juniorTrancheVaultContract.getNumEpochsWithRedemption()).to.equal(
                        0,
                    );
                });
            });

            describe("addRedemptionRequest", function () {
                it("Should reject redemption requests with 0 shares", async function () {
                    await expect(
                        juniorTrancheVaultContract.connect(lender).addRedemptionRequest(0),
                    ).to.be.revertedWithCustomError(
                        juniorTrancheVaultContract,
                        "zeroAmountProvided",
                    );
                });

                it("Should reject redemption requests when protocol is paused or pool is not on", async function () {
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

                it("Should reject redemption requests when the number of shares requested is greater than the user's balance", async function () {
                    const shares = await juniorTrancheVaultContract.balanceOf(lender.address);
                    await expect(
                        juniorTrancheVaultContract
                            .connect(lender)
                            .addRedemptionRequest(shares.add(BN.from(1))),
                    ).to.be.revertedWithCustomError(
                        juniorTrancheVaultContract,
                        "insufficientSharesForRequest",
                    );
                });

                it("Should reject redemption requests that would breach the pool owner treasury's liquidity requirement", async function () {
                    await expect(
                        juniorTrancheVaultContract
                            .connect(poolOwnerTreasury)
                            .addRedemptionRequest(BN.from(1)),
                    ).to.be.revertedWithCustomError(
                        poolConfigContract,
                        "poolOwnerNotEnoughLiquidity",
                    );
                });

                it("Should reject redemption requests that would breach the EA's liquidity requirement", async function () {
                    await expect(
                        juniorTrancheVaultContract
                            .connect(evaluationAgent)
                            .addRedemptionRequest(BN.from(1)),
                    ).to.be.revertedWithCustomError(
                        poolConfigContract,
                        "evaluationAgentNotEnoughLiquidity",
                    );
                });

                it("Should allow lenders to request redemption in the same epoch", async function () {
                    const shares = toToken(10_000);
                    const currentEpochId = await epochManagerContract.currentEpochId();
                    let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                    await expect(
                        juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(lender.address, shares, currentEpochId);
                    expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                        balance.sub(shares),
                    );

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender,
                        0,
                        shares,
                    );

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
                    ).to.equal(shares);

                    let epochId = await juniorTrancheVaultContract.epochIds(0);
                    expect(epochId).to.equal(currentEpochId);
                    await epochChecker.checkJuniorEpochInfoById(epochId, shares);

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

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender,
                        0,
                        shares.mul(BN.from(2)),
                    );

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
                    ).to.equal(shares.mul(BN.from(2)));

                    await epochChecker.checkJuniorEpochInfoById(epochId, shares.mul(BN.from(2)));

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

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender2,
                        0,
                        shares,
                    );
                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender,
                        0,
                        shares.mul(BN.from(2)),
                    );

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender2.address,
                        ),
                    ).to.equal(shares);

                    await epochChecker.checkJuniorEpochInfoById(epochId, shares.mul(BN.from(3)));
                });

                it("Should allow lenders to request redemption in the next epoch", async function () {
                    const shares = toToken(10_000);
                    let currentEpochId = await epochManagerContract.currentEpochId();
                    let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                    await expect(
                        juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(lender.address, shares, currentEpochId);
                    expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                        balance.sub(shares),
                    );

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender,
                        0,
                        shares,
                    );

                    let epochId = await juniorTrancheVaultContract.epochIds(0);
                    expect(epochId).to.equal(currentEpochId);
                    await epochChecker.checkJuniorEpochInfoById(epochId, shares);

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
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

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender,
                        1,
                        shares,
                        shares,
                    );

                    epochId = await juniorTrancheVaultContract.epochIds(1);
                    await epochChecker.checkJuniorEpochInfoById(epochId, shares);

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
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

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender2,
                        1,
                        shares,
                    );

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender2.address,
                        ),
                    ).to.equal(shares);

                    await epochChecker.checkJuniorEpochInfoById(epochId, shares.mul(BN.from(2)));

                    // Close current epoch while processing nothing
                    currentEpoch = await epochManagerContract.currentEpoch();
                    await mineNextBlockWithTimestamp(
                        currentEpoch.endTime.add(BN.from(60 * 5)).toNumber(),
                    );
                    const availableAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, availableAssets);
                    await epochManagerContract.closeEpoch();
                    currentEpochId = await epochManagerContract.currentEpochId();

                    // Lender2 requests redemption in next epoch
                    balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                    await expect(
                        juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(lender2.address, shares, currentEpochId);
                    expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                        balance.sub(shares),
                    );

                    await checkRedemptionDisbursementInfoByLender(
                        juniorTrancheVaultContract,
                        lender2,
                        2,
                        shares.mul(BN.from(2)),
                    );

                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender2.address,
                        ),
                    ).to.equal(shares.mul(BN.from(2)));

                    epochId = await juniorTrancheVaultContract.epochIds(2);
                    await epochChecker.checkJuniorEpochInfoById(epochId, shares.mul(BN.from(3)));
                });

                it("Should allow redemption requests from the pool owner treasury in the senior tranche w/o considering liquidity requirements", async function () {
                    const depositAmount = toToken(20_000);
                    await seniorTrancheVaultContract
                        .connect(poolOwnerTreasury)
                        .deposit(depositAmount, poolOwnerTreasury.address);

                    const currentEpochId = await epochManagerContract.currentEpochId();
                    const balance = await seniorTrancheVaultContract.balanceOf(
                        poolOwnerTreasury.address,
                    );
                    const sharesRequested = balance.sub(1);
                    await expect(
                        seniorTrancheVaultContract
                            .connect(poolOwnerTreasury)
                            .addRedemptionRequest(sharesRequested),
                    )
                        .to.emit(seniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(poolOwnerTreasury.address, sharesRequested, currentEpochId);
                    expect(
                        await seniorTrancheVaultContract.balanceOf(poolOwnerTreasury.address),
                    ).to.equal(balance.sub(sharesRequested));

                    await checkRedemptionDisbursementInfoByLender(
                        seniorTrancheVaultContract,
                        poolOwnerTreasury,
                        0,
                        sharesRequested,
                    );
                });

                it("Should allow redemption requests from the EA in the senior tranche w/o considering liquidity requirements", async function () {
                    const depositAmount = toToken(20_000);
                    await seniorTrancheVaultContract
                        .connect(evaluationAgent)
                        .deposit(depositAmount, evaluationAgent.address);

                    const currentEpochId = await epochManagerContract.currentEpochId();
                    const balance = await seniorTrancheVaultContract.balanceOf(
                        evaluationAgent.address,
                    );
                    const sharesRequested = balance.sub(1);
                    await expect(
                        seniorTrancheVaultContract
                            .connect(evaluationAgent)
                            .addRedemptionRequest(sharesRequested),
                    )
                        .to.emit(seniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(evaluationAgent.address, sharesRequested, currentEpochId);
                    expect(
                        await seniorTrancheVaultContract.balanceOf(evaluationAgent.address),
                    ).to.equal(balance.sub(sharesRequested));

                    await checkRedemptionDisbursementInfoByLender(
                        seniorTrancheVaultContract,
                        evaluationAgent,
                        0,
                        sharesRequested,
                    );
                });
            });

            describe("cancellableRedemptionShares", function () {
                it("Should return the correct number of cancellable redemption shares", async function () {
                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
                    ).to.equal(0);
                    let shares = toToken(10_000);
                    await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                    expect(
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        ),
                    ).to.equal(shares);
                });
            });

            describe("cancelRedemptionRequest", function () {
                it("Should not allow cancellation of redemption request with 0 shares", async function () {
                    await expect(
                        juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(0),
                    ).to.be.revertedWithCustomError(
                        juniorTrancheVaultContract,
                        "zeroAmountProvided",
                    );
                });

                it("Should not allow redemption request cancellation when protocol is paused or pool is not on", async function () {
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

                it("Should not allow redemption request cancellation with shares greater than requested shares", async function () {
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

                it("Should allow redemption request cancellation", async function () {
                    let shares = toToken(10_000);
                    await juniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                    // Lender removes redemption request
                    shares = toToken(1000);
                    let currentEpochId = await epochManagerContract.currentEpochId();
                    let balance = await juniorTrancheVaultContract.balanceOf(lender.address);
                    let epochBefore =
                        await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                    let cancellableRedemptionSharesBefore =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        );
                    await expect(
                        juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                        .withArgs(lender.address, shares, currentEpochId);
                    let epochAfter =
                        await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                    let cancellableRedemptionSharesAfter =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        );

                    expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                        balance.add(shares),
                    );
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
                    epochBefore =
                        await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                    cancellableRedemptionSharesBefore =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        );
                    await expect(
                        juniorTrancheVaultContract.connect(lender).cancelRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                        .withArgs(lender.address, shares, currentEpochId);
                    epochAfter =
                        await juniorTrancheVaultContract.epochInfoByEpochId(currentEpochId);
                    cancellableRedemptionSharesAfter =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender.address,
                        );

                    expect(await juniorTrancheVaultContract.balanceOf(lender.address)).to.equal(
                        balance.add(shares),
                    );
                    expect(
                        epochBefore.totalSharesRequested.sub(epochAfter.totalSharesRequested),
                    ).to.equal(shares);
                    expect(
                        cancellableRedemptionSharesBefore.sub(cancellableRedemptionSharesAfter),
                    ).to.equal(shares);

                    // Close current epoch while processing nothing
                    currentEpoch = await epochManagerContract.currentEpoch();
                    await mineNextBlockWithTimestamp(
                        currentEpoch.endTime.add(BN.from(60 * 5)).toNumber(),
                    );
                    const availableAssets = await poolSafeContract.getPoolLiquidity();
                    await creditContract.drawdown(ethers.constants.HashZero, availableAssets);
                    await epochManagerContract.closeEpoch();
                    currentEpochId = await epochManagerContract.currentEpochId();

                    // Lender2 requests redemption in next epoch
                    balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                    await expect(
                        juniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestAdded")
                        .withArgs(lender2.address, shares, currentEpochId);

                    // Lender2 removes redemption request
                    const allShares = shares.mul(BN.from(2));
                    balance = await juniorTrancheVaultContract.balanceOf(lender2.address);
                    cancellableRedemptionSharesBefore =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender2.address,
                        );
                    await expect(
                        juniorTrancheVaultContract
                            .connect(lender2)
                            .cancelRedemptionRequest(allShares),
                    )
                        .to.emit(juniorTrancheVaultContract, "RedemptionRequestRemoved")
                        .withArgs(lender2.address, allShares, currentEpochId);
                    cancellableRedemptionSharesAfter =
                        await juniorTrancheVaultContract.cancellableRedemptionShares(
                            lender2.address,
                        );

                    expect(await juniorTrancheVaultContract.balanceOf(lender2.address)).to.equal(
                        balance.add(allShares),
                    );
                    expect(
                        cancellableRedemptionSharesBefore.sub(cancellableRedemptionSharesAfter),
                    ).to.equal(allShares);
                    await epochChecker.checkJuniorEpochInfoById(currentEpochId);
                });
            });
        });

        describe("Disburse Tests", function () {
            it("Should not disburse when protocol is paused or pool is not on", async function () {
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

            it("Should disburse when one epoch was fully processed", async function () {
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
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender,
                    0,
                    BN.from(0),
                    shares,
                    shares,
                );

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, shares);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(shares),
                );
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender2,
                    0,
                    BN.from(0),
                    shares,
                    shares,
                );

                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(BN.from(0));
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender2.address),
                ).to.equal(BN.from(0));

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await seniorTrancheVaultContract.connect(lender).disburse(defaultDeployer.address);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore,
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await seniorTrancheVaultContract.connect(lender2).disburse(lender2.address);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(balanceBefore);
            });

            it("Should disbuse when epochs was partially processed", async function () {
                let shares = toToken(1000);
                let shares2 = toToken(2000);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets out of pool safe for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolSafeContract.getPoolLiquidity();
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
                let allWithdrawable = withdrawable;
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender,
                    1,
                    shares.sub(withdrawable),
                    allWithdrawable,
                    allWithdrawable,
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2),
                );
                let allWithdrawable2 = withdrawable2;
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender2,
                    1,
                    shares2.sub(withdrawable2),
                    allWithdrawable2,
                    allWithdrawable2,
                );

                let allShares = shares.sub(withdrawable);
                let allShares2 = shares2.sub(withdrawable2);
                let allAvailableAmount = shares.add(shares2).sub(availableAmount);

                shares = toToken(4000);
                shares2 = toToken(3000);
                availableAmount = toToken(2000);

                allShares = allShares.add(shares);
                allShares2 = allShares2.add(shares2);
                allAvailableAmount = allAvailableAmount.add(availableAmount);

                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);
                await seniorTrancheVaultContract.connect(lender2).addRedemptionRequest(shares2);

                // Move assets into pool safe for partial processing

                await creditContract.makePayment(ethers.constants.HashZero, allAvailableAmount);

                // Finish 2nd epoch and process epoch partially

                lastEpoch = await epochManagerContract.currentEpoch();
                let totalSharesRequested = (
                    await seniorTrancheVaultContract.epochInfoByEpochId(lastEpoch.id)
                ).totalSharesRequested;
                ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);
                await epochManagerContract.closeEpoch();

                withdrawable = allShares.mul(allAvailableAmount).div(totalSharesRequested);
                expect(
                    await seniorTrancheVaultContract.withdrawableAssets(lender.address),
                ).to.equal(withdrawable);
                withdrawable2 = allShares2.mul(allAvailableAmount).div(totalSharesRequested);
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
                allWithdrawable = allWithdrawable.add(withdrawable);
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender,
                    2,
                    allShares.sub(withdrawable),
                    allWithdrawable,
                    allWithdrawable,
                );

                balanceBefore = await mockTokenContract.balanceOf(lender2.address);
                await expect(seniorTrancheVaultContract.connect(lender2).disburse(lender2.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, lender2.address, withdrawable2);
                expect(await mockTokenContract.balanceOf(lender2.address)).to.equal(
                    balanceBefore.add(withdrawable2),
                );
                allWithdrawable2 = allWithdrawable2.add(withdrawable2);
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender2,
                    2,
                    allShares2.sub(withdrawable2),
                    allWithdrawable2,
                    allWithdrawable2,
                );

                allShares = allShares.sub(withdrawable);
                allShares2 = allShares2.sub(withdrawable2);

                // Move assets into pool safe for partial processing

                await creditContract.makePayment(
                    ethers.constants.HashZero,
                    allShares.add(allShares2),
                );

                // Finish 3rd epoch and process epoch fully

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

                balanceBefore = await mockTokenContract.balanceOf(lender.address);
                await expect(seniorTrancheVaultContract.connect(lender).disburse(lender.address))
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender.address, lender.address, allShares);
                expect(await mockTokenContract.balanceOf(lender.address)).to.equal(
                    balanceBefore.add(allShares),
                );
                allWithdrawable = allWithdrawable.add(allShares);
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender,
                    2,
                    BN.from(0),
                    allWithdrawable,
                    allWithdrawable,
                );

                balanceBefore = await mockTokenContract.balanceOf(defaultDeployer.address);
                await expect(
                    seniorTrancheVaultContract.connect(lender2).disburse(defaultDeployer.address),
                )
                    .to.emit(seniorTrancheVaultContract, "LenderFundDisbursed")
                    .withArgs(lender2.address, defaultDeployer.address, allShares2);
                expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                    balanceBefore.add(allShares2),
                );
                allWithdrawable2 = allWithdrawable2.add(allShares2);
                await checkRedemptionDisbursementInfoByLender(
                    seniorTrancheVaultContract,
                    lender2,
                    2,
                    BN.from(0),
                    allWithdrawable2,
                    allWithdrawable2,
                );
            });
        });

        describe("Process Epochs Tests", function () {
            it("Should not allow non-EpochManager to process epochs", async function () {
                await expect(
                    juniorTrancheVaultContract.executeEpoch({
                        epochId: 0,
                        totalSharesRequested: 0,
                        totalSharesProcessed: 0,
                        totalAmountProcessed: 0,
                    }),
                ).to.be.revertedWithCustomError(juniorTrancheVaultContract, "notAuthorizedCaller");
            });

            it("Should process one epoch fully", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                let lastEpoch = await epochManagerContract.currentEpoch();
                let ts = lastEpoch.endTime.toNumber() + 60 * 5;
                await setNextBlockTimestamp(ts);

                let totalSupply = await seniorTrancheVaultContract.totalSupply();
                let balance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochProcessed")
                    .withArgs(1, shares, shares, shares);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(shares),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(shares));

                await epochChecker.checkSeniorEpochInfoById(lastEpoch.id, shares, shares, shares);
                await epochChecker.checkSeniorCurrentEpochEmpty();
            });

            it("Should process one epoch partially", async function () {
                let shares = toToken(3000);
                await seniorTrancheVaultContract.connect(lender).addRedemptionRequest(shares);

                // Move assets out of pool safe for partial processing

                let availableAmount = toToken(1000);
                let availableAssets = await poolSafeContract.getPoolLiquidity();
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
                await expect(epochManagerContract.closeEpoch())
                    .to.emit(seniorTrancheVaultContract, "EpochProcessed")
                    .withArgs(1, shares, availableAmount, availableAmount);

                expect(await seniorTrancheVaultContract.totalSupply()).to.equal(
                    totalSupply.sub(availableAmount),
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.equal(balance.add(availableAmount));

                await epochChecker.checkSeniorEpochInfoById(
                    lastEpoch.id,
                    shares,
                    availableAmount,
                    availableAmount,
                );
                await epochChecker.checkSeniorCurrentEpochInfo(shares.sub(availableAmount));
            });
        });
    });
});
