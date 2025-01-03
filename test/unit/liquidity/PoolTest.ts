import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    EpochManager,
    FirstLossCover,
    HumaConfig,
    MockPoolCredit,
    MockPoolCreditManager,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    EpochChecker,
    FeeCalculator,
    FirstLossCoverInfo,
    PnLCalculator,
    deployAndSetupPoolContracts,
    deployPoolContracts,
    deployProtocolContracts,
    getAssetsAfterProfitAndLoss,
    mockDistributePnL,
} from "../../BaseTest";
import {
    getFirstLossCoverInfo,
    getLatestBlock,
    getMinLiquidityRequirementForEA,
    getMinLiquidityRequirementForPoolOwner,
    isCloseTo,
    overrideFirstLossCoverConfig,
    overrideLPConfig,
    setNextBlockTimestamp,
    sumBNArray,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let borrower: SignerWithAddress, lender: SignerWithAddress, lender2: SignerWithAddress;

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditManagerContract: MockPoolCreditManager,
    creditDueManagerContract: CreditDueManager;

let epochChecker: EpochChecker, feeCalculator: FeeCalculator;

describe("Pool Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            borrower,
            lender,
            lender2,
        ] = await ethers.getSigners();
    });

    describe("Before the pool is enabled", function () {
        let minPoolOwnerLiquidity: BN, minEALiquidity: BN;

        async function prepare() {
            [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                treasury,
                sentinelServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                adminFirstLossCoverContract,
                tranchesPolicyContract,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract as unknown,
                creditDueManagerContract,
                creditManagerContract as unknown,
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
                "MockPoolCreditManager",
            );

            // Set up first loss cover requirements.
            let lpConfig = await poolConfigContract.getLPConfig();
            await poolConfigContract
                .connect(poolOwner)
                .setLPConfig({ ...lpConfig, ...{ liquidityCap: toToken(1_000_000) } });
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await adminFirstLossCoverContract
                .connect(poolOwner)
                .addCoverProvider(poolOwnerTreasury.address);

            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(evaluationAgent.address);
            await adminFirstLossCoverContract
                .connect(poolOwner)
                .addCoverProvider(evaluationAgent.address);

            minPoolOwnerLiquidity =
                await getMinLiquidityRequirementForPoolOwner(poolConfigContract);
            minEALiquidity = await getMinLiquidityRequirementForEA(poolConfigContract);
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        async function addLiquidity(
            poolOwnerAmountForJuniorTranche: BN,
            poolOwnerAmountForSeniorTranche: BN,
            eaAmount: BN,
        ) {
            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(poolSafeContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await juniorTrancheVaultContract
                .connect(poolOwnerTreasury)
                .makeInitialDeposit(poolOwnerAmountForJuniorTranche);
            if (poolOwnerAmountForSeniorTranche.gt(0)) {
                await seniorTrancheVaultContract
                    .connect(poolOwnerTreasury)
                    .makeInitialDeposit(poolOwnerAmountForSeniorTranche);
            }

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(poolSafeContract.address, ethers.constants.MaxUint256);
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await juniorTrancheVaultContract.connect(evaluationAgent).makeInitialDeposit(eaAmount);
        }

        it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
            await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "PoolOwnerOrHumaOwnerRequired",
            );
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough first loss cover for the pool owner", async function () {
            const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    minLiquidity: coverTotalAssets.add(toToken(1)),
                },
            );

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "InsufficientFirstLossCover");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough first loss cover for the EA", async function () {
            const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    minLiquidity: coverTotalAssets.add(toToken(1)),
                },
            );

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "InsufficientFirstLossCover");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        describe("If the senior tranche is enabled", function () {
            let minDepositAmount: BN;

            beforeEach(async function () {
                const lpConfig = await poolConfigContract.getLPConfig();
                expect(lpConfig.maxSeniorJuniorRatio).to.be.gt(0);

                const poolSettings = await poolConfigContract.getPoolSettings();
                minDepositAmount = poolSettings.minDepositAmount;
            });

            it("Should not enable a pool when the pool owner has only satisfied the liquidity requirement for the junior tranche", async function () {
                await addLiquidity(minPoolOwnerLiquidity, toToken(0), minEALiquidity);

                await expect(
                    poolContract.connect(protocolOwner).enablePool(),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "PoolOwnerInsufficientLiquidity",
                );
                const isPoolOn = await poolContract.isPoolOn();
                expect(isPoolOn).to.be.false;
            });

            it("Should not enable a pool when the pool owner has only satisfied the liquidity requirement for the senior tranche", async function () {
                const lpConfig = await poolConfigContract.getLPConfig();
                // Deposit some fund into the junior tranche so that the senior tranche deposit is not blocked by the
                // max senior : junior ratio.
                await addLiquidity(
                    minPoolOwnerLiquidity.div(lpConfig.maxSeniorJuniorRatio).add(toToken(1)),
                    minDepositAmount,
                    minEALiquidity,
                );

                await expect(
                    poolContract.connect(protocolOwner).enablePool(),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "PoolOwnerInsufficientLiquidity",
                );
                const isPoolOn = await poolContract.isPoolOn();
                expect(isPoolOn).to.be.false;
            });

            it("Should not enable a pool when there is not enough liquidity for the EA", async function () {
                await addLiquidity(minPoolOwnerLiquidity, minDepositAmount, minEALiquidity.sub(1));

                await expect(
                    poolContract.connect(protocolOwner).enablePool(),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "EvaluationAgentInsufficientLiquidity",
                );
                const isPoolOn = await poolContract.isPoolOn();
                expect(isPoolOn).to.be.false;
            });

            it("Should allow the pool owner to enable a pool when conditions are met", async function () {
                await addLiquidity(minPoolOwnerLiquidity, minDepositAmount, minEALiquidity);

                await expect(poolContract.connect(protocolOwner).enablePool())
                    .to.emit(poolContract, "PoolEnabled")
                    .withArgs(protocolOwner.address);
                const isPoolOn = await poolContract.isPoolOn();
                expect(isPoolOn).to.be.true;
            });
        });

        describe("If the senior tranche is disabled", function () {
            beforeEach(async function () {
                await overrideLPConfig(poolConfigContract, poolOwner, {
                    maxSeniorJuniorRatio: 0,
                });
            });

            it("Should allow the pool owner to enable a pool when conditions are met", async function () {
                await addLiquidity(minPoolOwnerLiquidity, toToken(0), minEALiquidity);

                await expect(poolContract.connect(protocolOwner).enablePool())
                    .to.emit(poolContract, "PoolEnabled")
                    .withArgs(protocolOwner.address);
                const isPoolOn = await poolContract.isPoolOn();
                expect(isPoolOn).to.be.true;
            });
        });
    });

    describe("After the pool is enabled", function () {
        async function prepare() {
            [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
                protocolOwner,
                treasury,
                sentinelServiceAccount,
                poolOwner,
            );

            [
                poolConfigContract,
                poolFeeManagerContract,
                poolSafeContract,
                calendarContract,
                borrowerFirstLossCoverContract,
                adminFirstLossCoverContract,
                tranchesPolicyContract,
                poolContract,
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
                creditContract as unknown,
                creditDueManagerContract,
                creditManagerContract as unknown,
            ] = await deployAndSetupPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
                "MockPoolCreditManager",
                evaluationAgent,
                treasury,
                poolOwnerTreasury,
                poolOperator,
                [lender, lender2],
            );

            let juniorDepositAmount = toToken(400_000);
            await juniorTrancheVaultContract.connect(lender).deposit(juniorDepositAmount);
            let seniorDepositAmount = toToken(10_000);
            await seniorTrancheVaultContract.connect(lender).deposit(seniorDepositAmount);

            juniorDepositAmount = toToken(50_000);
            await juniorTrancheVaultContract.connect(lender2).deposit(juniorDepositAmount);
            seniorDepositAmount = toToken(20_000);
            await seniorTrancheVaultContract.connect(lender2).deposit(seniorDepositAmount);

            await overrideLPConfig(poolConfigContract, poolOwner, {
                withdrawalLockoutPeriodInDays: 0,
            });

            epochChecker = new EpochChecker(
                epochManagerContract,
                seniorTrancheVaultContract,
                juniorTrancheVaultContract,
            );
            feeCalculator = new FeeCalculator(humaConfigContract, poolConfigContract);
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        describe("disablePool", function () {
            it("Should not allow non-Operator to disable the pool", async function () {
                await expect(poolContract.disablePool()).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "PoolOperatorRequired",
                );
                expect(await poolContract.isPoolOn()).to.be.true;
            });

            it("Should allow a pool operator to disable the pool", async function () {
                await expect(poolContract.connect(poolOperator).disablePool())
                    .to.emit(poolContract, "PoolDisabled")
                    .withArgs(poolOperator.address);
                expect(await poolContract.isPoolOn()).to.be.false;
            });
        });

        describe("closePool", function () {
            async function testClosePool(
                seniorSharesRequested: BN,
                seniorSharesRedeemable: BN,
                juniorSharesRequested: BN,
                juniorSharesRedeemable: BN,
                profit: BN = BN.from(0),
                loss: BN = BN.from(0),
                lossRecovery: BN = BN.from(0),
                delta: number = 0,
            ) {
                const currentEpoch = await epochManagerContract.currentEpoch();

                const [[seniorAssets, juniorAssets]] = await getAssetsAfterProfitAndLoss(
                    poolConfigContract,
                    poolContract,
                    [borrowerFirstLossCoverContract, adminFirstLossCoverContract],
                    poolOwner,
                    feeCalculator,
                    profit,
                    loss,
                    lossRecovery,
                );
                const seniorTotalSupply = await seniorTrancheVaultContract.totalSupply();
                const seniorTokenPrice = seniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(seniorTotalSupply);
                const seniorAmountRedeemable = seniorSharesRedeemable
                    .mul(seniorTokenPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
                const expectedSeniorAssets = seniorAssets.sub(seniorAmountRedeemable);
                const seniorTokenBalance = await mockTokenContract.balanceOf(
                    seniorTrancheVaultContract.address,
                );

                const juniorTotalSupply = await juniorTrancheVaultContract.totalSupply();
                const juniorTokenPrice = juniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(juniorTotalSupply);
                const juniorAmountRedeemable = juniorSharesRedeemable
                    .mul(juniorTokenPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
                const expectedJuniorAssets = juniorAssets.sub(juniorAmountRedeemable);
                const juniorTokenBalance = await mockTokenContract.balanceOf(
                    juniorTrancheVaultContract.address,
                );
                const expectedUnprocessedAmount = seniorSharesRequested
                    .sub(seniorSharesRedeemable)
                    .mul(seniorTokenPrice)
                    .add(juniorSharesRequested.sub(juniorSharesRedeemable).mul(juniorTokenPrice))
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);

                await mockDistributePnL(
                    creditContract,
                    creditManagerContract,
                    profit,
                    loss,
                    lossRecovery,
                );
                await seniorTrancheVaultContract.processYieldForLenders();
                await juniorTrancheVaultContract.processYieldForLenders();

                await expect(poolContract.connect(poolOwner).closePool())
                    .to.emit(poolContract, "PoolClosed")
                    .withArgs(poolOwner.address)
                    .to.emit(epochManagerContract, "RedemptionRequestsProcessed")
                    .withArgs(
                        (actualSeniorAssets: BN) =>
                            isCloseTo(actualSeniorAssets, expectedSeniorAssets, delta),
                        seniorTokenPrice.div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
                        (actualJuniorAssets: BN) =>
                            isCloseTo(actualJuniorAssets, expectedJuniorAssets, delta),
                        juniorTokenPrice.div(CONSTANTS.DEFAULT_DECIMALS_FACTOR),
                        (actualUnprocessedAmount: BN) =>
                            isCloseTo(actualUnprocessedAmount, expectedUnprocessedAmount, delta),
                    )
                    .to.emit(epochManagerContract, "EpochProcessedAfterPoolClosure")
                    .withArgs(currentEpoch.id.toNumber());

                // Ensure that the remaining assets and supply match the expected amount.
                expect(await seniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                    expectedSeniorAssets,
                    delta,
                );
                expect(await seniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                    seniorTotalSupply.sub(seniorSharesRedeemable),
                    delta,
                );
                expect(
                    await mockTokenContract.balanceOf(seniorTrancheVaultContract.address),
                ).to.be.closeTo(seniorTokenBalance.add(seniorAmountRedeemable), delta);
                expect(await juniorTrancheVaultContract.totalAssets()).to.be.closeTo(
                    expectedJuniorAssets,
                    delta,
                );
                expect(await juniorTrancheVaultContract.totalSupply()).to.be.closeTo(
                    juniorTotalSupply.sub(juniorSharesRedeemable),
                    delta,
                );
                expect(
                    await mockTokenContract.balanceOf(juniorTrancheVaultContract.address),
                ).to.be.closeTo(juniorTokenBalance.add(juniorAmountRedeemable), delta);

                expect(await poolContract.readyForFirstLossCoverWithdrawal()).to.be.true;
            }

            async function calcAmountsToRedeem(
                profit: BN,
                loss: BN,
                lossRecovery: BN,
                seniorSharesToRedeem: BN,
                juniorSharesToRedeem: BN,
            ) {
                const [[seniorAssets, juniorAssets]] = await getAssetsAfterProfitAndLoss(
                    poolConfigContract,
                    poolContract,
                    [borrowerFirstLossCoverContract, adminFirstLossCoverContract],
                    poolOwner,
                    feeCalculator,
                    profit,
                    loss,
                    lossRecovery,
                );
                const seniorSupply = await seniorTrancheVaultContract.totalSupply();
                const seniorPrice = seniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(seniorSupply);
                const seniorAmountProcessable = seniorSharesToRedeem
                    .mul(seniorPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);
                const juniorSupply = await juniorTrancheVaultContract.totalSupply();
                const juniorPrice = juniorAssets
                    .mul(CONSTANTS.DEFAULT_DECIMALS_FACTOR)
                    .div(juniorSupply);
                const juniorAmountProcessable = juniorSharesToRedeem
                    .mul(juniorPrice)
                    .div(CONSTANTS.DEFAULT_DECIMALS_FACTOR);

                return [seniorAmountProcessable, juniorAmountProcessable];
            }

            it("Should close the pool and successfully process one senior redemption request", async function () {
                const sharesToRedeem = toToken(2539);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(lender.address, sharesToRedeem);

                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                const [amountToRedeem] = await calcAmountsToRedeem(
                    profit,
                    loss,
                    lossRecovery,
                    sharesToRedeem,
                    BN.from(0),
                );
                let epochId = await epochManagerContract.currentEpochId();
                await testClosePool(
                    sharesToRedeem,
                    sharesToRedeem,
                    BN.from(0),
                    BN.from(0),
                    profit,
                    loss,
                    lossRecovery,
                );
                await epochChecker.checkSeniorRedemptionSummaryById(
                    epochId,
                    sharesToRedeem,
                    sharesToRedeem,
                    amountToRedeem,
                );
            });

            it("Should close the pool and successfully process multiple senior redemption requests", async function () {
                const epochId = await epochManagerContract.currentEpochId();

                const lenderSharesRequested = toToken(236);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(lender.address, lenderSharesRequested);
                const lender2SharesRequested = toToken(1357);
                await seniorTrancheVaultContract
                    .connect(lender2)
                    .addRedemptionRequest(lender2.address, lender2SharesRequested);
                const totalSharesRequested = lenderSharesRequested.add(lender2SharesRequested);
                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                const [expectedSeniorAmountProcessed] = await calcAmountsToRedeem(
                    profit,
                    loss,
                    lossRecovery,
                    totalSharesRequested,
                    BN.from(0),
                );
                await testClosePool(
                    totalSharesRequested,
                    totalSharesRequested,
                    BN.from(0),
                    BN.from(0),
                    profit,
                    loss,
                    lossRecovery,
                );

                await epochChecker.checkSeniorRedemptionSummaryById(
                    epochId,
                    totalSharesRequested,
                    totalSharesRequested,
                    expectedSeniorAmountProcessed,
                );
            });

            it("Should close the pool and successfully process one junior redemption request", async function () {
                const sharesToRedeem = toToken(1);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .addRedemptionRequest(lender.address, sharesToRedeem);

                const profit = toToken(198),
                    loss = toToken(67),
                    lossRecovery = toToken(39);
                const [, amountToRedeem] = await calcAmountsToRedeem(
                    profit,
                    loss,
                    lossRecovery,
                    BN.from(0),
                    sharesToRedeem,
                );

                const epochId = await epochManagerContract.currentEpochId();
                await testClosePool(
                    BN.from(0),
                    BN.from(0),
                    sharesToRedeem,
                    sharesToRedeem,
                    profit,
                    loss,
                    lossRecovery,
                );
                await epochChecker.checkJuniorRedemptionSummaryById(
                    epochId,
                    sharesToRedeem,
                    sharesToRedeem,
                    amountToRedeem,
                );
            });

            it("Should not allow non-PoolOwner or non-HumaOwner to close the pool", async function () {
                await expect(poolContract.closePool()).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "PoolOwnerOrHumaOwnerRequired",
                );
                expect(await poolContract.isPoolClosed()).to.be.false;
            });

            it("Should not close the pool if there is unprocessed profit in the senior tranche", async function () {
                // Distribute profit and then process yield for the junior tranche so that there are unprocessed profits
                // in the senior tranche only.
                await mockDistributePnL(
                    creditContract,
                    creditManagerContract,
                    toToken(10_000),
                    0,
                    0,
                );
                await juniorTrancheVaultContract.processYieldForLenders();
                expect(
                    await poolSafeContract.unprocessedTrancheProfit(
                        seniorTrancheVaultContract.address,
                    ),
                ).to.be.gt(0);
                expect(
                    await poolSafeContract.unprocessedTrancheProfit(
                        juniorTrancheVaultContract.address,
                    ),
                ).to.equal(0);

                await expect(
                    poolContract.connect(poolOwner).closePool(),
                ).to.be.revertedWithCustomError(
                    epochManagerContract,
                    "RedemptionsCannotBeProcessedDueToUnprocessedProfit",
                );
            });

            it("Should not close the pool if there is unprocessed profit in the junior tranche", async function () {
                // Distribute profit and then process yield for the senior tranche so that there are unprocessed profits
                // in the junior tranche only.
                await mockDistributePnL(
                    creditContract,
                    creditManagerContract,
                    toToken(10_000),
                    0,
                    0,
                );
                await seniorTrancheVaultContract.processYieldForLenders();
                expect(
                    await poolSafeContract.unprocessedTrancheProfit(
                        seniorTrancheVaultContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await poolSafeContract.unprocessedTrancheProfit(
                        juniorTrancheVaultContract.address,
                    ),
                ).to.be.gt(0);

                await expect(
                    poolContract.connect(poolOwner).closePool(),
                ).to.be.revertedWithCustomError(
                    epochManagerContract,
                    "RedemptionsCannotBeProcessedDueToUnprocessedProfit",
                );
            });
        });

        describe("setReadyForFirstLossCoverWithdrawal", function () {
            it("Should allow the pool owner to set the flag", async function () {
                await expect(
                    poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true),
                ).to.emit(poolContract, "FirstLossCoverWithdrawalReadinessChanged");
                expect(await poolContract.readyForFirstLossCoverWithdrawal()).to.be.true;
            });

            it("Should allow the Huma owner to set the flag", async function () {
                await expect(
                    poolContract.connect(protocolOwner).setReadyForFirstLossCoverWithdrawal(true),
                ).to.emit(poolContract, "FirstLossCoverWithdrawalReadinessChanged");
                expect(await poolContract.readyForFirstLossCoverWithdrawal()).to.be.true;
            });

            it("Should not allow non-pool-owner or non-Huma-owner to set the flag", async function () {
                await expect(
                    poolContract.setReadyForFirstLossCoverWithdrawal(true),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "PoolOwnerOrHumaOwnerRequired",
                );
            });
        });

        describe("PnL tests", function () {
            let firstLossCovers: FirstLossCover[];
            let coverTotalAssets: BN;

            async function prepareForPnL() {
                // Override the config so that first loss covers cover
                // all losses up to the amount of their total assets.
                firstLossCovers = [borrowerFirstLossCoverContract, adminFirstLossCoverContract];
                // Make sure both first loss covers have some assets.
                await mockTokenContract.mint(borrower.getAddress(), toToken(1_000_000_000));
                await mockTokenContract
                    .connect(borrower)
                    .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
                await borrowerFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(borrower.getAddress());
                await borrowerFirstLossCoverContract
                    .connect(borrower)
                    .depositCover(toToken(100_000));
                const borrowerFLCAssets = await borrowerFirstLossCoverContract.totalAssets();
                expect(borrowerFLCAssets).to.be.gt(0);
                const adminFLCAssets = await adminFirstLossCoverContract.totalAssets();
                expect(adminFLCAssets).to.be.gt(0);
                coverTotalAssets = borrowerFLCAssets.add(adminFLCAssets);
                for (const [index, cover] of firstLossCovers.entries()) {
                    await overrideFirstLossCoverConfig(
                        cover,
                        index,
                        poolConfigContract,
                        poolOwner,
                        {
                            coverRatePerLossInBps: CONSTANTS.BP_FACTOR,
                            coverCapPerLoss: coverTotalAssets,
                        },
                    );
                }
            }

            beforeEach(async function () {
                await loadFixture(prepareForPnL);
            });

            describe("distribute PnL", function () {
                async function testDistribution(profit: BN, loss: BN, recovery: BN) {
                    const adjustment = 8000;
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    let assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE],
                    ];

                    let firstLossCoverInfos: FirstLossCoverInfo[] = [],
                        newFirstLossCoverInfos: FirstLossCoverInfo[] = [],
                        seniorAssets,
                        juniorAssets,
                        totalAssets,
                        firstLossCoverProfits: BN[] = [],
                        losses: BN[] = [],
                        lossesCoveredByFirstLossCovers: BN[] = [];

                    if (profit.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );
                        const profitAfterFees =
                            await feeCalculator.calcPoolFeeDistribution(profit);
                        const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                            profitAfterFees,
                            assets,
                            BN.from(adjustment),
                        );
                        let juniorProfitAfterFirstLossCoverProfitDistribution;
                        [
                            juniorProfitAfterFirstLossCoverProfitDistribution,
                            firstLossCoverProfits,
                        ] = await PnLCalculator.calcProfitForFirstLossCovers(
                            assetsWithProfits[CONSTANTS.JUNIOR_TRANCHE].sub(
                                assets[CONSTANTS.JUNIOR_TRANCHE],
                            ),
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                            firstLossCoverInfos,
                        );

                        await expect(creditContract.mockDistributeProfit(profit))
                            .to.emit(poolContract, "ProfitDistributed")
                            .withArgs(
                                profit,
                                assetsWithProfits[CONSTANTS.SENIOR_TRANCHE],
                                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                    juniorProfitAfterFirstLossCoverProfitDistribution,
                                ),
                            );

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(assetsWithProfits[CONSTANTS.SENIOR_TRANCHE]);
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(
                            assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                juniorProfitAfterFirstLossCoverProfitDistribution,
                            ),
                        );
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        newFirstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );

                        newFirstLossCoverInfos.forEach((info, index) => {
                            expect(info.asset).to.equal(
                                firstLossCoverInfos[index].asset.add(firstLossCoverProfits[index]),
                            );
                        });

                        assets = [seniorAssets, juniorAssets];
                    }

                    if (loss.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );

                        let assetsWithLosses;
                        [assetsWithLosses, losses, lossesCoveredByFirstLossCovers] =
                            await PnLCalculator.calcLoss(
                                loss,
                                [
                                    assets[CONSTANTS.SENIOR_TRANCHE],
                                    assets[CONSTANTS.JUNIOR_TRANCHE],
                                ],
                                firstLossCoverInfos,
                            );

                        if (
                            losses[CONSTANTS.SENIOR_TRANCHE]
                                .add(losses[CONSTANTS.JUNIOR_TRANCHE])
                                .gt(0)
                        ) {
                            await expect(creditManagerContract.mockDistributeLoss(loss))
                                .to.emit(poolContract, "LossDistributed")
                                .withArgs(
                                    loss.sub(sumBNArray([...lossesCoveredByFirstLossCovers])),
                                    assetsWithLosses[CONSTANTS.SENIOR_TRANCHE],
                                    assetsWithLosses[CONSTANTS.JUNIOR_TRANCHE],
                                    losses[CONSTANTS.SENIOR_TRANCHE],
                                    losses[CONSTANTS.JUNIOR_TRANCHE],
                                );
                        } else {
                            await creditManagerContract.mockDistributeLoss(loss);
                        }

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(assetsWithLosses[CONSTANTS.SENIOR_TRANCHE]);
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(assetsWithLosses[CONSTANTS.JUNIOR_TRANCHE]);
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        for (const [index, cover] of [
                            borrowerFirstLossCoverContract,
                            adminFirstLossCoverContract,
                        ].entries()) {
                            expect(await cover.coveredLoss()).to.equal(
                                lossesCoveredByFirstLossCovers[index],
                            );
                        }
                        assets = [seniorAssets, juniorAssets];
                    }

                    if (recovery.gt(0)) {
                        firstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );
                        const [
                            ,
                            assetsWithRecovery,
                            lossesWithRecovery,
                            lossRecoveredByFirstLossCovers,
                        ] = await PnLCalculator.calcLossRecovery(
                            recovery,
                            assets,
                            losses,
                            lossesCoveredByFirstLossCovers,
                        );

                        await expect(creditContract.mockDistributeLossRecovery(recovery))
                            .to.emit(poolContract, "LossRecoveryDistributed")
                            .withArgs(
                                losses[CONSTANTS.SENIOR_TRANCHE]
                                    .sub(lossesWithRecovery[CONSTANTS.SENIOR_TRANCHE])
                                    .add(losses[CONSTANTS.JUNIOR_TRANCHE])
                                    .sub(lossesWithRecovery[CONSTANTS.JUNIOR_TRANCHE]),
                                assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                                assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                                lossesWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                                lossesWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                            );

                        seniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.SENIOR_TRANCHE,
                        );
                        expect(seniorAssets).to.equal(
                            assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE],
                        );
                        juniorAssets = await poolContract.trancheTotalAssets(
                            CONSTANTS.JUNIOR_TRANCHE,
                        );
                        expect(juniorAssets).to.equal(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        totalAssets = await poolContract.totalAssets();
                        expect(totalAssets).to.equal(seniorAssets.add(juniorAssets));

                        newFirstLossCoverInfos = await Promise.all(
                            [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                                (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                            ),
                        );
                        newFirstLossCoverInfos.forEach((info, index) => {
                            expect(info.asset).to.equal(
                                firstLossCoverInfos[index].asset.add(
                                    lossRecoveredByFirstLossCovers[index],
                                ),
                            );
                        });
                    }
                }

                it("Should distribute profit correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when first loss covers can cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0),
                        loss = coverTotalAssets.sub(toToken(1)),
                        recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(toToken(1));
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.JUNIOR_TRANCHE],
                    );
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute loss correctly when the junior tranche can cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .sub(toToken(1));
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(toToken(1));
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute loss correctly when the senior tranche needs to cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE])
                        .sub(toToken(1));
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(toToken(1));
                });

                it("Should distribute loss correctly when the loss exceeds tranche total assets", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE])
                        .add(toToken(1_000));
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(0);
                });

                it("Should distribute loss recovery correctly when senior loss can be partially recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.SENIOR_TRANCHE].add(assets[CONSTANTS.JUNIOR_TRANCHE]),
                    );
                    const recovery = assets[CONSTANTS.SENIOR_TRANCHE].sub(toToken(1));

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(0);
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE].sub(toToken(1)),
                    );
                });

                it("Should distribute loss recovery correctly when junior loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE]);
                    const recovery = assets[CONSTANTS.SENIOR_TRANCHE].add(toToken(1));

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(toToken(1));
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute loss recovery correctly when the admin first loss can be partially recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );
                    const recovery = assets[CONSTANTS.JUNIOR_TRANCHE]
                        .add(assets[CONSTANTS.SENIOR_TRANCHE])
                        .add(toToken(1));

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(0);
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(toToken(1));
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.JUNIOR_TRANCHE],
                    );
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute loss recovery correctly when the borrower first loss can be partially recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const adminFLCAssets = await adminFirstLossCoverContract.totalAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE]);
                    const recovery = adminFLCAssets
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE])
                        .add(toToken(1));

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                        toToken(1),
                    );
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                        adminFLCAssets,
                    );
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.JUNIOR_TRANCHE],
                    );
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute loss recovery correctly when all loss can be fully recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const borrowerFLCAssets = await borrowerFirstLossCoverContract.totalAssets();
                    const adminFLCAssets = await adminFirstLossCoverContract.totalAssets();
                    const profit = toToken(0);
                    const loss = coverTotalAssets.add(
                        assets[CONSTANTS.JUNIOR_TRANCHE].add(assets[CONSTANTS.SENIOR_TRANCHE]),
                    );
                    const recovery = borrowerFLCAssets
                        .add(adminFLCAssets)
                        .add(assets[CONSTANTS.JUNIOR_TRANCHE])
                        .add(assets[CONSTANTS.SENIOR_TRANCHE]);

                    await testDistribution(profit, loss, recovery);

                    expect(await borrowerFirstLossCoverContract.totalAssets()).to.equal(
                        borrowerFLCAssets,
                    );
                    expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                        adminFLCAssets,
                    );
                    expect(await juniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.JUNIOR_TRANCHE],
                    );
                    expect(await seniorTrancheVaultContract.totalAssets()).to.equal(
                        assets[CONSTANTS.SENIOR_TRANCHE],
                    );
                });

                it("Should distribute profit, loss and loss recovery correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(8493);
                    const recovery = toToken(3485);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should not allow non-credit or non-credit manager to distribute profit", async function () {
                    await expect(
                        poolContract.connect(lender).distributeProfit(toToken(1)),
                    ).to.be.revertedWithCustomError(
                        poolContract,
                        "AuthorizedContractCallerRequired",
                    );
                });

                it("Should not allow non-credit manager to distribute loss", async function () {
                    await expect(
                        poolContract.connect(lender).distributeLoss(toToken(1)),
                    ).to.be.revertedWithCustomError(
                        poolContract,
                        "AuthorizedContractCallerRequired",
                    );
                });

                it("Should not allow non-credit to distribute loss recovery", async function () {
                    await expect(
                        poolContract.connect(lender).distributeLossRecovery(toToken(1)),
                    ).to.be.revertedWithCustomError(
                        poolContract,
                        "AuthorizedContractCallerRequired",
                    );
                });
            });

            describe("trancheTotalAssets and totalAssets", function () {
                async function testAssetCalculation(profit: BN, loss: BN, recovery: BN) {
                    const adjustment = 8000;
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    const assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE],
                    ];
                    const profitAfterFees = await feeCalculator.calcPoolFeeDistribution(profit);
                    const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                        profitAfterFees,
                        assets,
                        BN.from(adjustment),
                    );
                    const firstLossCoverInfos = await Promise.all(
                        [borrowerFirstLossCoverContract, adminFirstLossCoverContract].map(
                            (contract) => getFirstLossCoverInfo(contract, poolConfigContract),
                        ),
                    );
                    const [juniorProfitAfterFirstLossCoverProfitDistribution] =
                        await PnLCalculator.calcProfitForFirstLossCovers(
                            assetsWithProfits[CONSTANTS.JUNIOR_TRANCHE].sub(
                                assets[CONSTANTS.JUNIOR_TRANCHE],
                            ),
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                            firstLossCoverInfos,
                        );
                    const [assetsWithLosses, losses, lossesCoveredBuFirstLossCovers] =
                        await PnLCalculator.calcLoss(
                            loss,
                            [
                                assetsWithProfits[CONSTANTS.SENIOR_TRANCHE],
                                assets[CONSTANTS.JUNIOR_TRANCHE].add(
                                    juniorProfitAfterFirstLossCoverProfitDistribution,
                                ),
                            ],
                            firstLossCoverInfos,
                        );
                    const [, assetsWithRecovery] = await PnLCalculator.calcLossRecovery(
                        recovery,
                        assetsWithLosses,
                        losses,
                        lossesCoveredBuFirstLossCovers,
                    );

                    await mockDistributePnL(
                        creditContract,
                        creditManagerContract,
                        profit,
                        loss,
                        recovery,
                    );
                    const totalAssets = await poolContract.totalAssets();
                    expect(totalAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE].add(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE],
                        ),
                    );
                    const seniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.SENIOR_TRANCHE,
                    );
                    expect(seniorAssets).to.equal(assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE]);
                    const juniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.JUNIOR_TRANCHE,
                    );
                    expect(juniorAssets).to.equal(assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE]);
                }

                it("Should return the correct asset distribution when there is only profit", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);
                    await testAssetCalculation(profit, loss, recovery);
                });

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and first loss cover can cover the loss",
                    async function () {},
                );

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and the junior tranche needs to cover the loss",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.JUNIOR_TRANCHE];
                        const recovery = toToken(0);

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and the senior tranche needs to cover the loss",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = toToken(0);

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the senior loss can be recovered",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = assets[CONSTANTS.JUNIOR_TRANCHE];

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the junior loss can be recovered",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );
                        const recovery = assets[CONSTANTS.SENIOR_TRANCHE].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE],
                        );

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the first loss cover loss can be recovered",
                    async function () {},
                );

                it("Should return the correct profit, loss and loss recovery distribution", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(8493);
                    const recovery = toToken(3485);
                    await testAssetCalculation(profit, loss, recovery);
                });
            });
        });

        describe("updateTranchesAssets", function () {
            let tranchesAssets: [BN, BN];

            beforeEach(async function () {
                tranchesAssets = [toToken(100_000_000), toToken(100_000_000)];
            });

            it("Should allow the tranche vault to update", async function () {
                await poolConfigContract
                    .connect(poolOwner)
                    .setTranches(defaultDeployer.getAddress(), defaultDeployer.getAddress());
                await poolContract.connect(poolOwner).updatePoolConfigData();

                await poolContract.updateTranchesAssets(tranchesAssets);

                expect(await poolContract.currentTranchesAssets()).to.eql(tranchesAssets);
            });

            it("Should allow the epoch manager to update", async function () {
                await poolConfigContract
                    .connect(poolOwner)
                    .setEpochManager(defaultDeployer.getAddress());
                await poolContract.connect(poolOwner).updatePoolConfigData();

                await poolContract.updateTranchesAssets(tranchesAssets);

                expect(await poolContract.currentTranchesAssets()).to.eql(tranchesAssets);
            });

            it("Should not allow non-tranche vault or non-epoch manager to update tranches assets", async function () {
                await expect(
                    poolContract.connect(lender).updateTranchesAssets(tranchesAssets),
                ).to.be.revertedWithCustomError(poolContract, "AuthorizedContractCallerRequired");
            });
        });

        describe("getTrancheAvailableCap", function () {
            it("Should return the correct tranche available caps", async function () {
                await seniorTrancheVaultContract.connect(lender).deposit(toToken(10000));
                await juniorTrancheVaultContract.connect(lender).deposit(toToken(10000));

                const seniorAvailableCap = await poolContract.getTrancheAvailableCap(
                    CONSTANTS.SENIOR_TRANCHE,
                );
                const juniorAvailableCap = await poolContract.getTrancheAvailableCap(
                    CONSTANTS.JUNIOR_TRANCHE,
                );
                const lpConfig = await poolConfigContract.getLPConfig();
                const tranchesAssets = await poolContract.currentTranchesAssets();
                expect(seniorAvailableCap).to.be.gt(0);
                expect(juniorAvailableCap).to.be.gt(0);
                expect(juniorAvailableCap).to.equal(
                    lpConfig.liquidityCap.sub(
                        tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(
                            tranchesAssets[CONSTANTS.SENIOR_TRANCHE],
                        ),
                    ),
                );
                expect(seniorAvailableCap).to.equal(
                    tranchesAssets[CONSTANTS.JUNIOR_TRANCHE]
                        .mul(lpConfig.maxSeniorJuniorRatio)
                        .sub(tranchesAssets[CONSTANTS.SENIOR_TRANCHE]),
                );
                // Should return 0 if the index is not junior or senior.
                expect(await poolContract.getTrancheAvailableCap(2)).to.equal(0);
            });

            describe("For the senior tranche", function () {
                it("Should return the smaller of the total available cap and the senior available cap", async function () {
                    // Override the senior: junior ratio to be an extremely large number so that the available cap is
                    // determined by the total available cap.
                    const newRatio = 100;
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        maxSeniorJuniorRatio: newRatio,
                    });

                    const poolTotalAssets = await poolContract.totalAssets();
                    const poolConfig = await poolConfigContract.getLPConfig();
                    expect(
                        await poolContract.getTrancheAvailableCap(CONSTANTS.SENIOR_TRANCHE),
                    ).to.equal(poolConfig.liquidityCap.sub(poolTotalAssets));
                });

                it("Should return 0 if the senior total assets is already higher than the 'junior total assets * max senior : junior ratio'", async function () {
                    await seniorTrancheVaultContract.connect(lender).deposit(toToken(10_000));
                    await juniorTrancheVaultContract.connect(lender).deposit(toToken(10_000));

                    const [seniorAssets, juniorAssets] =
                        await poolContract.currentTranchesAssets();
                    // Make sure the liquidity cap is high enough so that the senior available cap is not constraint
                    // by the liquidity cap.
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        liquidityCap: seniorAssets.add(toToken(1)),
                    });
                    // Mark all junior assets as loss.
                    await mockDistributePnL(
                        creditContract,
                        creditManagerContract,
                        0,
                        juniorAssets,
                        0,
                    );
                    const [newSeniorAssets, newJuniorAssets] =
                        await poolContract.currentTranchesAssets();
                    expect(newJuniorAssets).to.equal(0);
                    expect(newSeniorAssets).to.equal(seniorAssets);

                    expect(
                        await poolContract.getTrancheAvailableCap(CONSTANTS.SENIOR_TRANCHE),
                    ).to.equal(0);
                });
            });
        });

        describe("trancheTotalAssets", function () {
            it("Should return the total assets of the given tranche", async function () {
                const tranchesAssets = await poolContract.currentTranchesAssets();
                expect(await poolContract.trancheTotalAssets(CONSTANTS.JUNIOR_TRANCHE)).to.equal(
                    tranchesAssets[CONSTANTS.JUNIOR_TRANCHE],
                );
                expect(await poolContract.trancheTotalAssets(CONSTANTS.SENIOR_TRANCHE)).to.equal(
                    tranchesAssets[CONSTANTS.SENIOR_TRANCHE],
                );
            });
        });

        describe("totalAssets", function () {
            it("Should return the combined total assets of all tranches", async function () {
                const tranchesAssets = await poolContract.currentTranchesAssets();
                expect(await poolContract.totalAssets()).to.equal(
                    tranchesAssets[CONSTANTS.JUNIOR_TRANCHE].add(
                        tranchesAssets[CONSTANTS.SENIOR_TRANCHE],
                    ),
                );
            });
        });

        describe("currentTranchesAssets", function () {
            it("Should return the total assets of each tranche", async function () {
                const tranchesAssets = await poolContract.tranchesAssets();
                expect(await poolContract.currentTranchesAssets()).to.eql([
                    tranchesAssets.seniorTotalAssets,
                    tranchesAssets.juniorTotalAssets,
                ]);
            });
        });

        describe("getFirstLossCovers", function () {
            it("Should return the first loss covers", async function () {
                expect(await poolContract.getFirstLossCovers()).to.eql([
                    borrowerFirstLossCoverContract.address,
                    adminFirstLossCoverContract.address,
                ]);
            });
        });
    });
});
