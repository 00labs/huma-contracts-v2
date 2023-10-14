import { ethers } from "hardhat";

import { expect } from "chai";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { BigNumber as BN } from "ethers";
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
    PoolFeeManager,
    Pool,
    PoolConfig,
    PoolSafe,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
    ProfitEscrow,
} from "../typechain-types";
import { FirstLossCoverStorage } from "../typechain-types/contracts/FirstLossCover";
import { copyLPConfigWithOverrides, minBigNumber, toToken } from "./TestUtils";

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
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

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
            affiliateFirstLossCoverProfitEscrowContract,
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
            const oldEASharesInEscrow = (
                await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                    evaluationAgent.getAddress(),
                )
            ).amount;

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
            expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                oldEABalance.sub(assets),
            );
            expect(
                await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverContractBalance.add(assets));
            expect(
                (
                    await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                        evaluationAgent.getAddress(),
                    )
                ).amount,
            ).to.equal(oldEASharesInEscrow.add(expectedShares));
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
            const oldEASharesInEscrow = (
                await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                    evaluationAgent.getAddress(),
                )
            ).amount;

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
            expect(
                (
                    await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                        evaluationAgent.getAddress(),
                    )
                ).amount,
            ).to.equal(oldEASharesInEscrow.add(expectedShares));
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
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolFeeManager");
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
        // TODO(jiatu): add more tests after clarifying if the comparison between totalAssets
        // and the cap is correct.
        async function depositCover(assets: BN) {
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

            await affiliateFirstLossCoverContract.connect(evaluationAgent).depositCover(assets);
        }

        describe("When the pool is not ready for first loss cover withdrawal", function () {
            it("Should allow the cover provider to redeem excessive assets over the cover cap", async function () {
                const tranchesAssets = await poolContract.tranchesAssets();
                const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                    tranchesAssets.juniorTotalAssets,
                );
                const coverAvailableCap = await poolContract.getFirstLossCoverAvailableCap(
                    affiliateFirstLossCoverContract.address,
                    totalTrancheAssets,
                );
                const assetsToRedeem = toToken(5_000);
                await depositCover(coverAvailableCap.add(assetsToRedeem));

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    affiliateFirstLossCoverContract.address,
                );
                const oldEASharesInEscrow = (
                    await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                        evaluationAgent.getAddress(),
                    )
                ).amount;

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
                expect(
                    (
                        await affiliateFirstLossCoverProfitEscrowContract.userInfo(
                            evaluationAgent.getAddress(),
                        )
                    ).amount,
                ).to.equal(oldEASharesInEscrow.sub(sharesToRedeem));
            });

            // it("Should disallow the cover provider to redeem assets if the cap hasn't been reached", async function () {
            //     const tranchesAssets = await poolContract.tranchesAssets();
            //     const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(tranchesAssets.juniorTotalAssets);
            //     const coverAvailableCap = await poolContract.getFirstLossCoverAvailableCap(affiliateFirstLossCoverContract.address, totalTrancheAssets);
            //     const assetsToRedeem = toToken(5_000);
            //     await depositCover(coverAvailableCap.add(assetsToRedeem));
            //
            //     const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
            //     const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
            //     const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);
            //
            //     await expect(affiliateFirstLossCoverContract.connect(evaluationAgent).redeemCover(sharesToRedeem, evaluationAgent.getAddress())).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "poolIsNotReadyForFirstLossCoverWithdrawal")
            // })

            it("Should disallow the cover provider to redeem more shares than they own", async function () {
                const tranchesAssets = await poolContract.tranchesAssets();
                const totalTrancheAssets = tranchesAssets.seniorTotalAssets.add(
                    tranchesAssets.juniorTotalAssets,
                );
                const coverAvailableCap = await poolContract.getFirstLossCoverAvailableCap(
                    affiliateFirstLossCoverContract.address,
                    totalTrancheAssets,
                );
                const assetsToRedeem = toToken(5_000);
                await depositCover(coverAvailableCap.add(assetsToRedeem));

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
            const config = await poolConfigContract.getFirstLossCoverConfig(
                affiliateFirstLossCoverContract.address,
            );
            const newConfig = {
                ...config,
                ...{
                    coverRateInBps: coverRateInBps,
                    coverCap: coverCap,
                },
            };
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    affiliateFirstLossCoverContract.address,
                    newConfig,
                    affiliateFirstLossCoverProfitEscrowContract.address,
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

                expect(await affiliateFirstLossCoverContract.calcLossCover(loss)).to.equal(
                    remainingLoss,
                );
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

            beforeEach(async function () {
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
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
                    const lpConfig = await poolConfigContract.getLPConfig();
                    const newLPConfig = copyLPConfigWithOverrides(lpConfig, {
                        liquidityCap: minFromPoolValue.add(1),
                    });
                    await poolConfigContract.connect(poolOwner).setLPConfig(newLPConfig);
                    await depositCover(newLPConfig.liquidityCap);

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
});
