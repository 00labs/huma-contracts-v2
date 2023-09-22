import { ethers } from "hardhat";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    CONSTANTS,
    deployAndSetupPoolContracts,
    deployPoolContracts,
    deployProtocolContracts,
    PnLCalculator,
} from "./BaseTest";
import {
    copyLPConfigWithOverrides,
    getLatestBlock,
    setNextBlockTimestamp,
    toToken,
} from "./TestUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
    BasePnLManager,
    Calendar,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    HumaConfig,
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
let lender: SignerWithAddress;

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

describe("Pool Test", function () {
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

    describe("Before the pool is enabled", function () {
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
            ] = await deployPoolContracts(
                humaConfigContract,
                mockTokenContract,
                "RiskAdjustedTranchesPolicy",
                defaultDeployer,
                poolOwner,
                "MockPoolCredit",
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-poolOwner and non-protocolAdmin to enable a pool", async function () {
            await expect(poolContract.enablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "permissionDeniedNotAdmin",
            );
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should not enable a pool when there is not enough first loss cover", async function () {
            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolOwnerAndEAFirstLossCoverContract, "notOperator");

            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256,
                );
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolOwnerAndEAFirstLossCoverContract, "notOperator");

            let eaNFTTokenId;
            // Mint EANFT to the ea
            const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
            const receipt = await tx.wait();
            for (const evt of receipt.events!) {
                if (evt.event === "NFTGenerated") {
                    eaNFTTokenId = evt.args!.tokenId;
                }
            }
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256,
                );
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(evaluationAgent)
                .addCover(toToken(50_000));

            await expect(
                poolContract.connect(protocolOwner).enablePool(),
            ).to.be.revertedWithCustomError(poolConfigContract, "lessThanRequiredCover");
            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.false;
        });

        it("Should allow the pool owner to enable a pool then conditions are met", async function () {
            await poolConfigContract.connect(poolOwner).setPoolLiquidityCap(toToken(1_000_000));
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerTreasury(poolOwnerTreasury.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(poolOwnerTreasury.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(poolOwnerTreasury)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256,
                );
            await mockTokenContract.mint(poolOwnerTreasury.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .addCover(toToken(200_000));

            let eaNFTTokenId;
            const tx = await eaNFTContract.mintNFT(evaluationAgent.address);
            const receipt = await tx.wait();
            for (const evt of receipt.events!) {
                if (evt.event === "NFTGenerated") {
                    eaNFTTokenId = evt.args!.tokenId;
                }
            }
            await poolConfigContract
                .connect(poolOwner)
                .setEvaluationAgent(eaNFTTokenId, evaluationAgent.address);
            await poolOwnerAndEAFirstLossCoverContract
                .connect(poolOwner)
                .setOperator(evaluationAgent.address, {
                    poolCapCoverageInBps: 1000,
                    poolValueCoverageInBps: 1000,
                });

            await mockTokenContract
                .connect(evaluationAgent)
                .approve(
                    poolOwnerAndEAFirstLossCoverContract.address,
                    ethers.constants.MaxUint256,
                );
            await mockTokenContract.mint(evaluationAgent.address, toToken(10_000_000));
            await poolOwnerAndEAFirstLossCoverContract
                .connect(evaluationAgent)
                .addCover(toToken(200_000));

            await expect(poolContract.connect(protocolOwner).enablePool())
                .to.emit(poolContract, "PoolEnabled")
                .withArgs(protocolOwner.address);

            const isPoolOn = await poolContract.isPoolOn();
            expect(isPoolOn).to.be.true;
        });
    });

    describe("After the pool is enabled", function () {
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
                [lender],
            );
        }

        beforeEach(async function () {
            await loadFixture(prepare);
        });

        it("Should not allow non-Operator to disable a pool", async function () {
            await expect(poolContract.disablePool()).to.be.revertedWithCustomError(
                poolConfigContract,
                "poolOperatorRequired",
            );
        });

        it("Should disable a pool", async function () {
            await expect(poolContract.connect(poolOperator).disablePool())
                .to.emit(poolContract, "PoolDisabled")
                .withArgs(poolOperator.address);
        });

        describe("PnL tests", function () {
            async function prepareForPnL() {
                let juniorDepositAmount = toToken(250_000);
                await juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(juniorDepositAmount, lender.address);
                let seniorDepositAmount = toToken(800_000);
                await seniorTrancheVaultContract
                    .connect(lender)
                    .deposit(seniorDepositAmount, lender.address);
            }

            beforeEach(async function () {
                await loadFixture(prepareForPnL);
            });

            describe("refreshPool", function () {
                async function testDistribution(profit: BN, loss: BN, recovery: BN) {
                    await creditContract.setRefreshPnLReturns(profit, loss, recovery);
                    await poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(defaultDeployer.address);
                    const adjustment = 8000;
                    const lpConfig = await poolConfigContract.getLPConfig();
                    const newLpConfig = copyLPConfigWithOverrides(lpConfig, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });
                    await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    const assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE_INDEX],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                    ];
                    const profitAfterFees =
                        await platformFeeManagerContract.calcPlatformFeeDistribution(profit);
                    const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                        profitAfterFees,
                        assets,
                        BN.from(adjustment),
                    );
                    const [assetsWithLosses, losses] = PnLCalculator.calcLoss(
                        loss,
                        assetsWithProfits,
                    );
                    const [, assetsWithRecovery, lossesWithRecovery] =
                        PnLCalculator.calcLossRecovery(recovery, assetsWithLosses, losses);

                    await expect(await poolContract.refreshPool())
                        .to.emit(poolContract, "PoolAssetsRefreshed")
                        .withArgs(
                            nextTS,
                            profit,
                            loss,
                            recovery,
                            assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                            lossesWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
                            lossesWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        );

                    // All getters now should return the most up-to-date data.
                    const totalAssets = await poolContract.totalAssets();
                    expect(totalAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        ),
                    );
                    const seniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.SENIOR_TRANCHE_INDEX,
                    );
                    expect(seniorAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
                    );
                    const juniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.JUNIOR_TRANCHE_INDEX,
                    );
                    expect(juniorAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                    );
                }

                it("Should distribute profit correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when first loss covers can cover loss", async function () {});

                it("Should distribute loss correctly when the junior tranche can cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss correctly when the senior tranche needs to cover loss", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(
                        assets[CONSTANTS.SENIOR_TRANCHE_INDEX],
                    );
                    const recovery = toToken(0);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when senior loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                        assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                    );
                    const recovery = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when junior loss can be recovered", async function () {
                    const assets = await poolContract.currentTranchesAssets();
                    const profit = toToken(0);
                    const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(
                        assets[CONSTANTS.SENIOR_TRANCHE_INDEX],
                    );
                    const recovery = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX].add(
                        assets[CONSTANTS.SENIOR_TRANCHE_INDEX],
                    );

                    await testDistribution(profit, loss, recovery);
                });

                it("Should distribute loss recovery correctly when first loss can be recovered", async function () {});

                it("Should distribute profit, loss and loss recovery correctly", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(8493);
                    const recovery = toToken(3485);

                    await testDistribution(profit, loss, recovery);
                });

                it("Should not allow non-tranche vault or non-epoch manager to distribute PnL", async function () {
                    await expect(
                        poolContract.connect(lender).refreshPool(),
                    ).to.be.revertedWithCustomError(
                        poolConfigContract,
                        "notTrancheVaultOrEpochManager",
                    );
                });
            });

            describe("trancheTotalAssets and totalAssets", function () {
                async function testAssetCalculation(profit: BN, loss: BN, recovery: BN) {
                    await creditContract.setRefreshPnLReturns(profit, loss, recovery);
                    await poolConfigContract
                        .connect(poolOwner)
                        .setEpochManager(defaultDeployer.address);
                    const adjustment = 8000;
                    const lpConfig = await poolConfigContract.getLPConfig();
                    const newLpConfig = copyLPConfigWithOverrides(lpConfig, {
                        tranchesRiskAdjustmentInBps: adjustment,
                    });
                    await poolConfigContract.connect(poolOwner).setLPConfig(newLpConfig);

                    const block = await getLatestBlock();
                    const nextTS = block.timestamp + 5;
                    await setNextBlockTimestamp(nextTS);

                    const assetInfo = await poolContract.tranchesAssets();
                    const assets = [
                        assetInfo[CONSTANTS.SENIOR_TRANCHE_INDEX],
                        assetInfo[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                    ];
                    const profitAfterFees =
                        await platformFeeManagerContract.calcPlatformFeeDistribution(profit);
                    const assetsWithProfits = PnLCalculator.calcProfitForRiskAdjustedPolicy(
                        profitAfterFees,
                        assets,
                        BN.from(adjustment),
                    );
                    const [assetsWithLosses, losses] = PnLCalculator.calcLoss(
                        loss,
                        assetsWithProfits,
                    );
                    const [, assetsWithRecovery] = PnLCalculator.calcLossRecovery(
                        recovery,
                        assetsWithLosses,
                        losses,
                    );

                    const totalAssets = await poolContract.totalAssets();
                    expect(totalAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        ),
                    );
                    const seniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.SENIOR_TRANCHE_INDEX,
                    );
                    expect(seniorAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.SENIOR_TRANCHE_INDEX],
                    );
                    const juniorAssets = await poolContract.trancheTotalAssets(
                        CONSTANTS.JUNIOR_TRANCHE_INDEX,
                    );
                    expect(juniorAssets).to.equal(
                        assetsWithRecovery[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                    );
                }

                it("Should return the correct asset distribution when there is only profit", async function () {
                    const profit = toToken(12387);
                    const loss = toToken(0);
                    const recovery = toToken(0);

                    await testAssetCalculation(profit, loss, recovery);
                });

                it(
                    "Should return the correct asset distribution when there is profit ans loss," +
                        " and first loss cover can cover the loss",
                    async function () {},
                );

                it(
                    "Should return the correct asset distribution when there is profit and loss," +
                        " and the junior tranche needs to cover the loss",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];
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
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
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
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        );
                        const recovery = assets[CONSTANTS.JUNIOR_TRANCHE_INDEX];

                        await testAssetCalculation(profit, loss, recovery);
                    },
                );

                it(
                    "Should return the correct asset distribution when there is profit, loss and recovery," +
                        " and the junior loss can be recovered",
                    async function () {
                        const assets = await poolContract.currentTranchesAssets();
                        const profit = toToken(0);
                        const loss = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
                        );
                        const recovery = assets[CONSTANTS.SENIOR_TRANCHE_INDEX].add(
                            assets[CONSTANTS.JUNIOR_TRANCHE_INDEX],
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
    });
});
