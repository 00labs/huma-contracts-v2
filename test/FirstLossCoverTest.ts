import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
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
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { FirstLossCoverStorage } from "../typechain-types/contracts/FirstLossCover";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import {
    minBigNumber,
    overrideFirstLossCoverConfig,
    overrideLPConfig,
    toToken,
} from "./TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    lender: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigContract: PoolConfig,
    poolFeeManagerContract: PoolFeeManager,
    poolSafeContract: PoolSafe,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: BorrowerLevelCreditManager;

describe("FirstLossCover Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
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
            protocolTreasury,
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
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "BorrowerLevelCreditManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("updatePoolConfigData", function () {
        async function spendAllowance() {
            // Spend some of the allowance by covering loss in the pool.
            const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
            const coverRateInBps = BN.from(9_000),
                coverCap = coverTotalAssets.add(1_000),
                loss = toToken(5_000);
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    coverRateInBps: coverRateInBps,
                    coverCap: coverCap,
                },
            );
            const amountLossCovered = minBigNumber(
                loss.mul(coverRateInBps).div(CONSTANTS.BP_FACTOR),
                coverCap,
                coverTotalAssets,
            );
            await mockTokenContract.mint(
                affiliateFirstLossCoverContract.address,
                amountLossCovered,
            );
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            await affiliateFirstLossCoverContract.coverLoss(loss);
        }

        async function performUpdate(
            newPoolSafeContract: PoolSafe,
            newMockTokenContract: MockToken,
        ) {
            await spendAllowance();
            const PoolConfig = await ethers.getContractFactory("PoolConfig");
            const newPoolConfigContract = await PoolConfig.deploy();
            await newPoolConfigContract.deployed();

            // Update the contract addresses.
            await newPoolConfigContract.initialize("Test Pool", [
                humaConfigContract.address,
                newMockTokenContract.address,
                calendarContract.address,
                poolContract.address,
                newPoolSafeContract.address,
                poolFeeManagerContract.address,
                tranchesPolicyContract.address,
                epochManagerContract.address,
                seniorTrancheVaultContract.address,
                juniorTrancheVaultContract.address,
                creditContract.address,
                creditDueManagerContract.address,
                creditManagerContract.address,
            ]);
            await newPoolConfigContract.setFirstLossCover(
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                affiliateFirstLossCoverContract.address,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 20000,
                },
            );
            await affiliateFirstLossCoverContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address);
        }

        describe("When both the pool safe and the underlying token contracts are updated", function () {
            it("Should reset the allowance of the pool safe contract", async function () {
                const PoolSafe = await ethers.getContractFactory("PoolSafe");
                const newPoolSafeContract = await PoolSafe.deploy();
                await newPoolSafeContract.deployed();
                const MockToken = await ethers.getContractFactory("MockToken");
                const newMockTokenContract = await MockToken.deploy();
                await newMockTokenContract.deployed();
                await humaConfigContract
                    .connect(protocolOwner)
                    .setLiquidityAsset(newMockTokenContract.address, true);
                await performUpdate(newPoolSafeContract, newMockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        newPoolSafeContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
                // Make sure there is no allowance for the new pool in the old token contract, or the old pool in the
                // new token contract.
                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        newPoolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
            });
        });

        describe("When only the pool safe contract is updated", function () {
            it("Should reset the allowance of the pool safe contract", async function () {
                const PoolSafe = await ethers.getContractFactory("PoolSafe");
                const newPoolSafeContract = await PoolSafe.deploy();
                await newPoolSafeContract.deployed();
                await performUpdate(newPoolSafeContract, mockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        newPoolSafeContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When only the underlying token contract is updated", function () {
            it("Should reset the allowance of the pool safe contract", async function () {
                const MockToken = await ethers.getContractFactory("MockToken");
                const newMockTokenContract = await MockToken.deploy();
                await newMockTokenContract.deployed();
                await humaConfigContract
                    .connect(protocolOwner)
                    .setLiquidityAsset(newMockTokenContract.address, true);
                await performUpdate(poolSafeContract, newMockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When neither the pool safe nor the underlying token contract is updated", function () {
            it("Should not change the allowance", async function () {
                const existingAllowance = await mockTokenContract.allowance(
                    affiliateFirstLossCoverContract.address,
                    poolSafeContract.address,
                );
                await performUpdate(poolSafeContract, mockTokenContract);

                expect(
                    await mockTokenContract.allowance(
                        affiliateFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(existingAllowance);
            });
        });
    });

    describe("setCoverProvider and getCoverProviderConfig", function () {
        let lossCoverProviderConfig: FirstLossCoverStorage.LossCoverProviderConfigStruct;

        before(async function () {
            lossCoverProviderConfig = {
                poolCapCoverageInBps: 100,
                poolValueCoverageInBps: 200,
            };
        });

        it("Should allow the pool owner to add a cover provider", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .setCoverProvider(evaluationAgent.address, lossCoverProviderConfig),
            )
                .to.emit(affiliateFirstLossCoverContract, "CoverProviderSet")
                .withArgs(
                    evaluationAgent.address,
                    lossCoverProviderConfig.poolCapCoverageInBps,
                    lossCoverProviderConfig.poolValueCoverageInBps,
                );
            const config = await affiliateFirstLossCoverContract.getCoverProviderConfig(
                evaluationAgent.address,
            );
            expect(config.poolCapCoverageInBps).to.equal(
                lossCoverProviderConfig.poolCapCoverageInBps,
            );
            expect(config.poolValueCoverageInBps).to.equal(
                lossCoverProviderConfig.poolValueCoverageInBps,
            );
        });

        it("Should disallow non-pool owners to set cover provider", async function () {
            await expect(
                affiliateFirstLossCoverContract.setCoverProvider(
                    evaluationAgent.address,
                    lossCoverProviderConfig,
                ),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });

        it("Should disallow the cover provider address to be the zero address", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .setCoverProvider(ethers.constants.AddressZero, lossCoverProviderConfig),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "zeroAddressProvided",
            );
        });
    });

    describe("depositCover", function () {
        let assets: BN;

        before(async function () {
            assets = toToken(20_000);
        });

        it("Should allow a cover provider to deposit assets", async function () {
            // Add the evaluation agent as a cover provider.
            affiliateFirstLossCoverContract
                .connect(poolOwner)
                .setCoverProvider(evaluationAgent.getAddress(), {
                    poolCapCoverageInBps: 100,
                    poolValueCoverageInBps: 200,
                });
            // Top up the EA's wallet and allow the first loss cover contract to transfer assets from it.
            await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(affiliateFirstLossCoverContract.address, assets);

            const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
            const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
            const expectedShares = assets.mul(oldSupply).div(oldAssets);
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
            const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            const oldAssetsOf = await affiliateFirstLossCoverContract.totalAssetsOf(
                evaluationAgent.getAddress(),
            );

            await expect(
                affiliateFirstLossCoverContract.connect(evaluationAgent).depositCover(assets),
            )
                .to.emit(affiliateFirstLossCoverContract, "CoverDeposited")
                .withArgs(await evaluationAgent.getAddress(), assets, expectedShares);

            expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                oldSupply.add(expectedShares),
            );
            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                oldAssets.add(assets),
            );
            expect(
                await affiliateFirstLossCoverContract.totalAssetsOf(evaluationAgent.getAddress()),
            ).to.equal(oldAssetsOf.add(assets));
            expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                oldEABalance.sub(assets),
            );
            expect(
                await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverContractBalance.add(assets));
        });

        it("Should disallow 0 as the asset amount", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(ethers.constants.Zero),
            ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "zeroAmountProvided");
        });

        it("Should disallow non-cover providers to make deposits", async function () {
            await expect(
                affiliateFirstLossCoverContract.connect(lender).depositCover(assets),
            ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "notCoverProvider");
        });
    });

    describe("depositCoverFor", function () {
        let assets: BN;

        before(async function () {
            assets = toToken(20_000);
        });

        beforeEach(async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setPoolFeeManager(defaultDeployer.getAddress());
        });

        it("Should allow the pool fee manager to deposit on behalf of a cover provider", async function () {
            // Top up the pool fee manager's wallet and allow the first loss cover contract to transfer assets from it.
            await mockTokenContract.mint(defaultDeployer.getAddress(), assets);
            await mockTokenContract
                .connect(defaultDeployer)
                .approve(affiliateFirstLossCoverContract.address, assets);

            const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
            const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
            const expectedShares = assets.mul(oldSupply).div(oldAssets);
            const oldPoolFeeManagerBalance = await mockTokenContract.balanceOf(
                defaultDeployer.address,
            );
            const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );

            await expect(
                affiliateFirstLossCoverContract.depositCoverFor(
                    assets,
                    evaluationAgent.getAddress(),
                ),
            )
                .to.emit(affiliateFirstLossCoverContract, "CoverDeposited")
                .withArgs(await evaluationAgent.getAddress(), assets, expectedShares);

            expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                oldSupply.add(expectedShares),
            );
            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                oldAssets.add(assets),
            );
            expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                oldPoolFeeManagerBalance.sub(assets),
            );
            expect(
                await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverContractBalance.add(assets));
        });

        it("Should disallow 0 as the asset amount", async function () {
            await expect(
                affiliateFirstLossCoverContract.depositCoverFor(
                    ethers.constants.Zero,
                    evaluationAgent.getAddress(),
                ),
            ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "zeroAmountProvided");
        });

        it("Should disallow zero address as the receiver", async function () {
            await expect(
                affiliateFirstLossCoverContract.depositCoverFor(
                    assets,
                    ethers.constants.AddressZero,
                ),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "zeroAddressProvided",
            );
        });

        it("Should disallow non-pool owners to make deposit on behalf of the cover provider", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(lender)
                    .depositCoverFor(assets, evaluationAgent.getAddress()),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "notAuthorizedCaller",
            );
        });
    });

    describe("addCoverAssets", function () {
        let assets: BN;

        before(async function () {
            assets = toToken(20_000);
        });

        it("Should allow the pool to add cover assets from the pool safe", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            await mockTokenContract.mint(poolSafeContract.address, assets);

            const oldFirstLossCoverBalance = await mockTokenContract.balanceOf(
                affiliateFirstLossCoverContract.address,
            );
            const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);

            await expect(affiliateFirstLossCoverContract.addCoverAssets(assets))
                .to.emit(affiliateFirstLossCoverContract, "AssetsAdded")
                .withArgs(assets);

            expect(
                await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverBalance.add(assets));
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                oldPoolSafeBalance.sub(assets),
            );
        });

        it("Should disallow non-pools to add cover assets", async function () {
            await expect(
                affiliateFirstLossCoverContract.connect(lender).addCoverAssets(assets),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
        });
    });

    describe("redeemCover", function () {
        async function depositCover(
            assets: BN,
            profit: BN = BN.from(0),
            loss: BN = BN.from(0),
            lossRecovery: BN = BN.from(0),
        ) {
            // Add the evaluation agent as a cover provider.
            affiliateFirstLossCoverContract
                .connect(poolOwner)
                .setCoverProvider(evaluationAgent.getAddress(), {
                    poolCapCoverageInBps: 100,
                    poolValueCoverageInBps: 200,
                });
            // Top up the EA's wallet and allow the first loss cover contract to transfer assets from it.
            await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(affiliateFirstLossCoverContract.address, assets);

            // Distribute PnL so that the LP token isn't always 1:1 with the asset
            // when PnL is non-zero.
            await creditContract.mockDistributePnL(profit, loss, lossRecovery);
            await affiliateFirstLossCoverContract.connect(evaluationAgent).depositCover(assets);
        }

        describe("When the pool is not ready for first loss cover withdrawal", function () {
            async function setFirstLossCoverWithdrawalToNotReady() {
                await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(false);
            }

            async function testRedeemCover(
                assetsToRedeem: BN,
                profit: BN = BN.from(0),
                loss: BN = BN.from(0),
                lossRecovery: BN = BN.from(0),
            ) {
                const tranchesAssets = await poolContract.tranchesAssets();
                const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                    tranchesAssets.juniorTotalAssets,
                );
                const coverCap =
                    await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets);
                await depositCover(coverCap.add(assetsToRedeem), profit, loss, lossRecovery);

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    affiliateFirstLossCoverContract.address,
                );

                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                )
                    .to.emit(affiliateFirstLossCoverContract, "CoverRedeemed")
                    .withArgs(
                        await evaluationAgent.getAddress(),
                        await evaluationAgent.getAddress(),
                        sharesToRedeem,
                        assetsToRedeem,
                    );

                expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(assetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(assetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
                ).to.equal(oldFirstLossCoverContractBalance.sub(assetsToRedeem));
            }

            beforeEach(async function () {
                await loadFixture(setFirstLossCoverWithdrawalToNotReady);
            });

            it("Should allow the cover provider to redeem excessive assets over the cover cap", async function () {
                const assetsToRedeem = toToken(5_000);
                await testRedeemCover(assetsToRedeem);
            });

            it("Should allow the cover provider to redeem excessive assets over the cover cap when there is more profit than loss", async function () {
                const assetsToRedeem = toToken(5_000);
                const profit = toToken(178),
                    loss = toToken(132),
                    lossRecovery = toToken(59);
                await testRedeemCover(assetsToRedeem, profit, loss, lossRecovery);
            });

            it("Should allow the cover provider to redeem excessive assets over the cover cap when there is more loss than profit", async function () {
                const assetsToRedeem = toToken(5_000);
                const profit = toToken(132),
                    loss = toToken(1908),
                    lossRecovery = toToken(59);
                await testRedeemCover(assetsToRedeem, profit, loss, lossRecovery);
            });

            it("Should disallow the cover provider to redeem assets if the cap hasn't been reached", async function () {
                // Make the cap large enough so that the first loss cover total assets fall below the cover cap.
                const coverAssets = await affiliateFirstLossCoverContract.totalAssets();
                const liquidityCap = coverAssets.add(1);
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        liquidityCap,
                    },
                );
                const assetsToRedeem = toToken(5_000);

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);

                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "poolIsNotReadyForFirstLossCoverWithdrawal",
                );
            });

            it("Should disallow the cover provider to redeem more shares than they own", async function () {
                const tranchesAssets = await poolContract.tranchesAssets();
                const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                    tranchesAssets.juniorTotalAssets,
                );
                const coverCap =
                    await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets);
                const assetsToRedeem = toToken(5_000);
                await depositCover(coverCap.add(assetsToRedeem));

                const eaShares = await affiliateFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(eaShares.add(1), evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "insufficientSharesForRequest",
                );
            });

            it("Should disallow the cover provider to redeem more assets than the excessive amount over cap", async function () {
                // Make sure the cap is determined by tge liquidity cap for easier testing.
                const liquidityCap = toToken(1_000_000_000);
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        liquidityCap,
                        maxPercentOfPoolValueInBps: 0,
                    },
                );
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                // Make sure the total assets exceeds the cap by depositing the shortfall plus some buffer
                // as the excessive amount.
                const assetsToRedeem = toToken(1_000);
                await depositCover(
                    liquidityCap.sub(coverTotalAssets).add(assetsToRedeem).sub(toToken(500)),
                );
                const sharesToRedeem =
                    await affiliateFirstLossCoverContract.convertToShares(assetsToRedeem);

                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "insufficientAmountForRequest",
                );
            });

            it("Should disallow 0 as the number of shares", async function () {
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(ethers.constants.Zero, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "zeroAmountProvided",
                );
            });

            it("Should disallow 0 zero as the receiver", async function () {
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(toToken(5_000), ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "zeroAddressProvided",
                );
            });
        });

        describe("When the pool is ready for first loss cover withdrawal", function () {
            async function setFirstLossCoverWithdrawalToReady() {
                await poolContract.connect(poolOwner).setReadyForFirstLossCoverWithdrawal(true);
            }

            async function testRedeemCover(
                assetsToRedeem: BN,
                profit: BN = BN.from(0),
                loss: BN = BN.from(0),
                lossRecovery: BN = BN.from(0),
            ) {
                // Make sure the cap is determined by tge liquidity cap for easier testing.
                const liquidityCap = toToken(1_000_000_000);
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        liquidityCap,
                        maxPercentOfPoolValueInBps: 0,
                    },
                );
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                // Make sure the total assets exceeds the cap by depositing the shortfall plus some buffer
                // as the excessive amount.
                await depositCover(liquidityCap.sub(coverTotalAssets).add(assetsToRedeem.div(2)));
                const sharesToRedeem =
                    await affiliateFirstLossCoverContract.convertToShares(assetsToRedeem);

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    affiliateFirstLossCoverContract.address,
                );

                await creditContract.mockDistributePnL(profit, loss, lossRecovery);
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                )
                    .to.emit(affiliateFirstLossCoverContract, "CoverRedeemed")
                    .withArgs(
                        await evaluationAgent.getAddress(),
                        await evaluationAgent.getAddress(),
                        sharesToRedeem,
                        assetsToRedeem,
                    );

                expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(assetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(assetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
                ).to.equal(oldFirstLossCoverContractBalance.sub(assetsToRedeem));
            }

            beforeEach(async function () {
                await loadFixture(setFirstLossCoverWithdrawalToReady);
            });

            it("Should allow the cover provider to redeem any valid amount", async function () {
                const assetsToRedeem = toToken(1_000);
                await testRedeemCover(assetsToRedeem);
                await testRedeemCover(assetsToRedeem);
            });

            it("Should allow the cover provider to redeem any valid amount when there is more profit than loss", async function () {
                const assetsToRedeem = toToken(1_000);
                const profit = toToken(578),
                    loss = toToken(216),
                    lossRecovery = toToken(120);
                await testRedeemCover(assetsToRedeem, profit, loss, lossRecovery);
            });

            it("Should allow the cover provider to redeem any valid amount when there is more loss than profit", async function () {
                const assetsToRedeem = toToken(1_000);
                const profit = toToken(578),
                    loss = toToken(1230),
                    lossRecovery = toToken(120);
                await testRedeemCover(assetsToRedeem, profit, loss, lossRecovery);
            });

            it("Should disallow the cover provider to redeem more shares than they own", async function () {
                const tranchesAssets = await poolContract.tranchesAssets();
                const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                    tranchesAssets.juniorTotalAssets,
                );
                const coverCap =
                    await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets);
                const assetsToRedeem = toToken(5_000);
                await depositCover(coverCap.add(assetsToRedeem));

                const eaShares = await affiliateFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(eaShares.add(1), evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "insufficientSharesForRequest",
                );
            });

            it("Should disallow 0 as the number of shares", async function () {
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(ethers.constants.Zero, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "zeroAmountProvided",
                );
            });

            it("Should disallow 0 zero as the receiver", async function () {
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(toToken(5_000), ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(
                    affiliateFirstLossCoverContract,
                    "zeroAddressProvided",
                );
            });
        });
    });

    describe("Loss cover and recover", function () {
        async function setCoverConfig(coverRateInBps: BN, coverCap: BN) {
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    coverRateInBps,
                    coverCap,
                },
            );
        }

        describe("Cover loss", function () {
            async function testCoverLoss(coverRateInBps: BN, coverCap: BN, loss: BN) {
                // Make sure the available amount for cover is less than the loss.
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await setCoverConfig(coverRateInBps, coverCap);
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRateInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCap,
                    coverTotalAssets,
                );

                // Make sure the pool has enough balance to be transferred from.
                await mockTokenContract.mint(
                    affiliateFirstLossCoverContract.address,
                    amountLossCovered,
                );

                const remainingLoss = loss.sub(amountLossCovered);
                const oldCoveredLoss = await affiliateFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.add(amountLossCovered);
                const oldPoolSafeAssets = await poolSafeContract.totalLiquidity();

                await expect(affiliateFirstLossCoverContract.coverLoss(loss))
                    .to.emit(affiliateFirstLossCoverContract, "LossCovered")
                    .withArgs(amountLossCovered, remainingLoss, newCoveredLoss);
                expect(await poolSafeContract.totalLiquidity()).to.equal(
                    oldPoolSafeAssets.add(amountLossCovered),
                );
                expect(await affiliateFirstLossCoverContract.coveredLoss()).to.equal(
                    newCoveredLoss,
                );
            }

            async function setPool() {
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            }

            beforeEach(async function () {
                await loadFixture(setPool);
            });

            it("Should allow the pool to partially cover the loss", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                const coverRateInBps = BN.from(9_000),
                    coverCap = coverTotalAssets.add(1_000),
                    loss = toToken(5_000);
                await testCoverLoss(coverRateInBps, coverCap, loss);
            });

            it("Should allow the pool to fully cover the loss", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                const coverRateInBps = CONSTANTS.BP_FACTOR,
                    coverCap = coverTotalAssets.add(1_000),
                    loss = coverTotalAssets.sub(1_000);
                await testCoverLoss(coverRateInBps, coverCap, loss);
            });

            it("Should allow the pool to cover up to the cap", async function () {
                const coverRateInBps = BN.from(9_000),
                    coverCap = toToken(1),
                    loss = toToken(1);
                await testCoverLoss(coverRateInBps, coverCap, loss);
            });

            it("Should allow the pool to cover up to the total assets of the first loss cover contract", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                const coverRateInBps = BN.from(9_000),
                    coverCap = coverTotalAssets.add(1_000),
                    loss = coverTotalAssets.add(1_000);
                await testCoverLoss(coverRateInBps, coverCap, loss);
            });

            it("Should not allow non-pools to initiate loss coverage", async function () {
                await expect(
                    affiliateFirstLossCoverContract.connect(lender).coverLoss(toToken(1_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
            });
        });

        describe("Recover loss", function () {
            let loss: BN;

            beforeEach(async function () {
                loss = toToken(9_000);
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            });

            it("Should allow the pool to recover the loss", async function () {
                // Initiate loss coverage so that the loss can be recovered later,
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await setCoverConfig(CONSTANTS.BP_FACTOR, coverTotalAssets.add(1_000));
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRateInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCap,
                    coverTotalAssets,
                );
                await mockTokenContract.mint(
                    affiliateFirstLossCoverContract.address,
                    amountLossCovered,
                );
                await affiliateFirstLossCoverContract.coverLoss(loss);

                // Make sure the pool safe has enough balance to be transferred from.
                const lossRecovery = loss;
                await mockTokenContract.mint(poolSafeContract.address, lossRecovery);

                const amountRecovered = minBigNumber(amountLossCovered, lossRecovery);
                const oldCoveredLoss = await affiliateFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.sub(amountRecovered);
                const oldPoolSafeAssets = await poolSafeContract.totalLiquidity();

                const lossRecoverCalcResult =
                    await affiliateFirstLossCoverContract.calcLossRecover(lossRecovery);
                expect(lossRecoverCalcResult[0]).to.equal(lossRecovery.sub(amountLossCovered));
                expect(lossRecoverCalcResult[1]).to.equal(amountRecovered);
                await expect(affiliateFirstLossCoverContract.recoverLoss(lossRecovery))
                    .to.emit(affiliateFirstLossCoverContract, "LossRecovered")
                    .withArgs(amountRecovered, newCoveredLoss);
                expect(await poolSafeContract.totalLiquidity()).to.equal(
                    oldPoolSafeAssets.sub(amountRecovered),
                );
                expect(await affiliateFirstLossCoverContract.coveredLoss()).to.equal(
                    newCoveredLoss,
                );
            });

            it("Should disallow non-pool to recover loss", async function () {
                await expect(
                    affiliateFirstLossCoverContract.connect(lender).recoverLoss(loss),
                ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
            });
        });

        describe("isSufficient", function () {
            async function depositCover(assets: BN) {
                await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
                await mockTokenContract
                    .connect(evaluationAgent)
                    .approve(affiliateFirstLossCoverContract.address, assets);
                await affiliateFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(assets);
            }

            it(
                "Should return true if the provider has more balance than the min cover amount," +
                    " and the min cover amount is determined by the pool cap",
                async function () {
                    affiliateFirstLossCoverContract
                        .connect(poolOwner)
                        .setCoverProvider(evaluationAgent.getAddress(), {
                            // Cover the entire pool cap.
                            poolCapCoverageInBps: CONSTANTS.BP_FACTOR,
                            poolValueCoverageInBps: 200,
                        });

                    const poolAssets = await poolContract.totalAssets();
                    const lossCoverConfig =
                        await affiliateFirstLossCoverContract.getCoverProviderConfig(
                            evaluationAgent.getAddress(),
                        );
                    const minFromPoolValue = poolAssets
                        .mul(lossCoverConfig.poolValueCoverageInBps)
                        .div(CONSTANTS.BP_FACTOR);

                    // Override the pool cap so that the min from pool cap is greater than the cover from pool value.
                    const liquidityCap = minFromPoolValue.add(1);
                    await overrideLPConfig(poolConfigContract, poolOwner, {
                        liquidityCap: liquidityCap,
                    });
                    await depositCover(liquidityCap);

                    expect(
                        await affiliateFirstLossCoverContract.isSufficient(
                            evaluationAgent.getAddress(),
                        ),
                    ).to.be.true;
                },
            );

            it(
                "Should return true if the provider has more balance than the min cover amount," +
                    " and the min cover amount is determined by the pool value",
                async function () {
                    affiliateFirstLossCoverContract
                        .connect(poolOwner)
                        .setCoverProvider(evaluationAgent.getAddress(), {
                            poolCapCoverageInBps: 100,
                            // Cover the entire pool value.
                            poolValueCoverageInBps: CONSTANTS.BP_FACTOR,
                        });

                    const coverProviderConfig =
                        await affiliateFirstLossCoverContract.getCoverProviderConfig(
                            evaluationAgent.getAddress(),
                        );
                    const lpConfig = await poolConfigContract.getLPConfig();
                    const minCoverAmountFromPoolCap = lpConfig.liquidityCap
                        .mul(coverProviderConfig.poolCapCoverageInBps)
                        .div(CONSTANTS.BP_FACTOR);

                    // Deposit additional asset into the junior tranche so that the min cover amount determined from
                    // the pool assets exceed the one determined from the pool cap.
                    await juniorTrancheVaultContract
                        .connect(lender)
                        .deposit(minCoverAmountFromPoolCap, lender.getAddress());
                    const poolAssets = await poolContract.totalAssets();
                    await depositCover(poolAssets);

                    expect(
                        await affiliateFirstLossCoverContract.isSufficient(
                            evaluationAgent.getAddress(),
                        ),
                    ).to.be.true;
                },
            );

            it("Should return false if the provider has less balance than the min cover amount", async function () {
                const lossCoverConfig =
                    await affiliateFirstLossCoverContract.getCoverProviderConfig(
                        evaluationAgent.getAddress(),
                    );
                const newConfig = {
                    ...lossCoverConfig,
                    ...{
                        // Let the EA cover the entire pool value for easier testing.
                        poolValueCoverageInBps: CONSTANTS.BP_FACTOR,
                    },
                };
                await affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .setCoverProvider(evaluationAgent.getAddress(), newConfig);
                const eaCoverBalance = await affiliateFirstLossCoverContract.convertToAssets(
                    await affiliateFirstLossCoverContract.balanceOf(evaluationAgent.getAddress()),
                );
                // Deposit the cover balance into the junior tranche to make sure the pool total assets exceed the
                // cover amount.
                await juniorTrancheVaultContract
                    .connect(lender)
                    .deposit(eaCoverBalance, lender.getAddress());
                expect(
                    await affiliateFirstLossCoverContract.isSufficient(
                        evaluationAgent.getAddress(),
                    ),
                ).to.be.false;
            });
        });
    });

    describe("getCapacity", function () {
        it("Should return the liquidity cap if it's higher", async function () {
            const tranchesAssets = await poolContract.tranchesAssets();
            const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                tranchesAssets.juniorTotalAssets,
            );
            const config = await poolConfigContract.getFirstLossCoverConfig(
                affiliateFirstLossCoverContract.address,
            );
            const capFromPoolAssets = totalTrancheAssets
                .mul(config.maxPercentOfPoolValueInBps)
                .div(CONSTANTS.BP_FACTOR);
            const liquidityCap = capFromPoolAssets.add(1);
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap,
                },
            );
            expect(await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets)).to.equal(
                liquidityCap,
            );
        });

        it("Should return the cap from pool assets if it's higher", async function () {
            const liquidityCap = toToken(1),
                maxPercentOfPoolValueInBps = CONSTANTS.BP_FACTOR;
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap,
                    maxPercentOfPoolValueInBps,
                },
            );
            // Deposit the amount of the liquidity cap into the pool to make sure the cap calculated from
            // pool assets is higher.
            await juniorTrancheVaultContract
                .connect(lender)
                .deposit(liquidityCap, lender.getAddress());

            const tranchesAssets = await poolContract.tranchesAssets();
            const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                tranchesAssets.juniorTotalAssets,
            );
            const capFromPoolAssets = totalTrancheAssets
                .mul(maxPercentOfPoolValueInBps)
                .div(CONSTANTS.BP_FACTOR);
            expect(await affiliateFirstLossCoverContract.getCapacity(totalTrancheAssets)).to.equal(
                capFromPoolAssets,
            );
        });
    });

    describe("payoutYield", function () {
        it("Should revert while paying out yield to partial providers", async function () {
            let totalAssets = await affiliateFirstLossCoverContract.totalAssets();
            let cap = await affiliateFirstLossCoverContract.getCapacity(
                await poolContract.totalAssets(),
            );
            let yieldAmount = toToken(8273);
            // console.log(`totalAssets: ${totalAssets}, cap: ${cap}`);

            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap: totalAssets.sub(yieldAmount),
                },
            );

            await expect(
                affiliateFirstLossCoverContract.payoutYield([poolOwnerTreasury.address]),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "notAllProvidersPaidOut",
            );
        });

        it("Should do nothing when yield is 0", async function () {
            let totalAssets = await affiliateFirstLossCoverContract.totalAssets();
            let cap = await affiliateFirstLossCoverContract.getCapacity(
                await poolContract.totalAssets(),
            );

            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap: totalAssets,
                },
            );

            await affiliateFirstLossCoverContract.payoutYield([
                poolOwnerTreasury.address,
                evaluationAgent.address,
            ]);

            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(totalAssets);
        });

        it("Should pay out yield to all providers ", async function () {
            let totalAssets = await affiliateFirstLossCoverContract.totalAssets();
            let poolAssets = await poolContract.totalAssets();
            let yieldAmount = toToken(8273);

            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap: totalAssets.sub(yieldAmount),
                },
            );

            let poolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.address,
            );
            let evaluationAgentBalance = await mockTokenContract.balanceOf(
                evaluationAgent.address,
            );
            let totalShares = await affiliateFirstLossCoverContract.totalSupply();
            let poolOwnerTreasuryShares = await affiliateFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.address,
            );
            let evaluationAgentShares = await affiliateFirstLossCoverContract.balanceOf(
                evaluationAgent.address,
            );

            await expect(
                affiliateFirstLossCoverContract.payoutYield([
                    poolOwnerTreasury.address,
                    evaluationAgent.address,
                ]),
            )
                .to.emit(affiliateFirstLossCoverContract, "YieldPaidout")
                .withArgs(
                    poolOwnerTreasury.address,
                    poolOwnerTreasuryShares.mul(yieldAmount).div(totalShares),
                )
                .to.emit(affiliateFirstLossCoverContract, "YieldPaidout")
                .withArgs(
                    evaluationAgent.address,
                    evaluationAgentShares.mul(yieldAmount).div(totalShares),
                );

            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                totalAssets.sub(yieldAmount),
            );
            expect(await affiliateFirstLossCoverContract.getCapacity(poolAssets)).to.equal(
                totalAssets.sub(yieldAmount),
            );
            expect(await mockTokenContract.balanceOf(poolOwnerTreasury.address)).to.equal(
                poolOwnerTreasuryBalance.add(
                    poolOwnerTreasuryShares.mul(yieldAmount).div(totalShares),
                ),
            );
            expect(await mockTokenContract.balanceOf(evaluationAgent.address)).to.equal(
                evaluationAgentBalance.add(
                    evaluationAgentShares.mul(yieldAmount).div(totalShares),
                ),
            );
        });
    });
});
