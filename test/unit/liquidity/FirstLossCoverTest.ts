import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    CreditLineManager,
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
} from "../../../typechain-types";
import {
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    deployProxyContract,
} from "../../BaseTest";
import {
    getMinFirstLossCoverRequirement,
    minBigNumber,
    overrideFirstLossCoverConfig,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    evaluationAgent2: SignerWithAddress,
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
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: CreditLineManager;

describe("FirstLossCover Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            evaluationAgent2,
            poolOperator,
            lender,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            protocolTreasury,
            eaServiceAccount,
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
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "MockPoolCredit",
            "CreditLineManager",
            evaluationAgent,
            protocolTreasury,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("decimals", function () {
        it("Should return the correct number of decimals of the underlying token", async function () {
            const tokenDecimals = await mockTokenContract.decimals();
            expect(await adminFirstLossCoverContract.decimals()).to.equal(tokenDecimals);
        });
    });

    describe("updatePoolConfigData", function () {
        async function spendAllowance() {
            // Spend some of the allowance by covering loss in the pool.
            const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
            const coverRatePerLossInBps = BN.from(9_000),
                coverCapPerLoss = coverTotalAssets.add(1_000),
                loss = toToken(5_000);
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    coverRatePerLossInBps,
                    coverCapPerLoss,
                },
            );
            const amountLossCovered = minBigNumber(
                loss.mul(coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                coverCapPerLoss,
                coverTotalAssets,
            );
            await mockTokenContract.mint(adminFirstLossCoverContract.address, amountLossCovered);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            await adminFirstLossCoverContract.coverLoss(loss);
        }

        async function performUpdate(
            newPoolSafeContract: PoolSafe,
            newMockTokenContract: MockToken,
        ) {
            await spendAllowance();
            const PoolConfig = await ethers.getContractFactory("PoolConfig");
            const newPoolConfigContract = (await deployProxyContract(PoolConfig)) as PoolConfig;

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
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                adminFirstLossCoverContract.address,
                {
                    coverRatePerLossInBps: 0,
                    coverCapPerLoss: 0,
                    maxLiquidity: 0,
                    minLiquidity: 0,
                    riskYieldMultiplierInBps: 20000,
                },
            );
            await adminFirstLossCoverContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address);
        }

        describe("When both the pool safe and the underlying token contracts are updated", function () {
            it("Should reset the allowance of the pool safe contract", async function () {
                const PoolSafe = await ethers.getContractFactory("PoolSafe");
                const newPoolSafeContract = (await deployProxyContract(PoolSafe)) as PoolSafe;

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
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        newPoolSafeContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
                // Make sure there is no allowance for the new pool in the old token contract, or the old pool in the
                // new token contract.
                expect(
                    await mockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        newPoolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
            });
        });

        describe("When only the pool safe contract is updated", function () {
            it("Should reset the allowance of the pool safe contract", async function () {
                const PoolSafe = await ethers.getContractFactory("PoolSafe");
                const newPoolSafeContract = (await deployProxyContract(PoolSafe)) as PoolSafe;
                await performUpdate(newPoolSafeContract, mockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await mockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
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
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When neither the pool safe nor the underlying token contract is updated", function () {
            it("Should not change the allowance", async function () {
                const existingAllowance = await mockTokenContract.allowance(
                    adminFirstLossCoverContract.address,
                    poolSafeContract.address,
                );
                await performUpdate(poolSafeContract, mockTokenContract);

                expect(
                    await mockTokenContract.allowance(
                        adminFirstLossCoverContract.address,
                        poolSafeContract.address,
                    ),
                ).to.equal(existingAllowance);
            });
        });
    });

    describe("addCoverProvider and getCoverProviders", function () {
        it("Should allow the pool owner to add a cover provider", async function () {
            await expect(
                adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            )
                .to.emit(adminFirstLossCoverContract, "CoverProviderAdded")
                .withArgs(evaluationAgent2.address);

            // Adding a second time should cause an error.
            await expect(
                adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "AlreadyAProvider");
            const providers = await adminFirstLossCoverContract.getCoverProviders();
            expect(providers.includes(await evaluationAgent2.getAddress())).to.be.true;
        });

        it("Should disallow non-pool owners to add cover providers", async function () {
            await expect(
                adminFirstLossCoverContract.addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolOwnerRequired");
        });

        it("Should disallow the cover provider address to be the zero address", async function () {
            await expect(
                adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "ZeroAddressProvided");
        });

        it("Should disallow cover providers to be added if the number of providers has reached capacity", async function () {
            const numExistingProviders = (await adminFirstLossCoverContract.getCoverProviders())
                .length;
            for (let i = 0; i < 100 - numExistingProviders; ++i) {
                const provider = ethers.Wallet.createRandom();
                await adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(provider.getAddress());
            }
            await expect(
                adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "TooManyProviders");
        });
    });

    describe("removeCoverProvider", function () {
        describe("When the account being removed is not a cover provider", function () {
            it("Should throw an error", async function () {
                await expect(
                    adminFirstLossCoverContract
                        .connect(poolOwner)
                        .removeCoverProvider(evaluationAgent2.getAddress()),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "CoverProviderRequired",
                );
            });
        });

        describe("When the account is a cover provider", function () {
            async function addCoverProvider() {
                await adminFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress());
            }

            describe("If the provider has not deposited assets", function () {
                beforeEach(async function () {
                    await loadFixture(addCoverProvider);
                });

                it("Should allow the provider to be removed", async function () {
                    const oldProviders = await adminFirstLossCoverContract.getCoverProviders();
                    expect(oldProviders.includes(await evaluationAgent2.getAddress())).to.be.true;

                    await expect(
                        adminFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    )
                        .to.emit(adminFirstLossCoverContract, "CoverProviderRemoved")
                        .withArgs(await evaluationAgent2.getAddress());

                    // Removing a second time should cause an error.
                    await expect(
                        adminFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    ).to.be.revertedWithCustomError(
                        adminFirstLossCoverContract,
                        "CoverProviderRequired",
                    );

                    const newProviders = await adminFirstLossCoverContract.getCoverProviders();
                    expect(newProviders.includes(await evaluationAgent2.getAddress())).to.be.false;
                });

                it("Should not allow non-pool owners to remove cover providers", async function () {
                    await expect(
                        adminFirstLossCoverContract
                            .connect(lender)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    ).to.be.revertedWithCustomError(poolConfigContract, "PoolOwnerRequired");
                });

                it("Should not remove providers with zero address", async function () {
                    await expect(
                        adminFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(ethers.constants.AddressZero),
                    ).to.be.revertedWithCustomError(poolConfigContract, "ZeroAddressProvided");
                });
            });

            describe("If the provider has deposited assets", function () {
                let providerAssets: BN;

                async function prepare() {
                    providerAssets = toToken(10_000);

                    const currentCoverTotalAssets =
                        await adminFirstLossCoverContract.totalAssets();

                    await overrideFirstLossCoverConfig(
                        adminFirstLossCoverContract,
                        CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                        poolConfigContract,
                        poolOwner,
                        {
                            maxLiquidity: currentCoverTotalAssets.add(providerAssets),
                        },
                    );

                    await addCoverProvider();

                    await mockTokenContract.mint(evaluationAgent2.getAddress(), providerAssets);
                    await mockTokenContract
                        .connect(evaluationAgent2)
                        .approve(adminFirstLossCoverContract.address, providerAssets);
                    await adminFirstLossCoverContract
                        .connect(evaluationAgent2)
                        .depositCover(providerAssets);
                }

                beforeEach(async function () {
                    await loadFixture(prepare);
                });

                it("Should not allow the provider to be removed", async function () {
                    await expect(
                        adminFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    )
                        .to.emit(adminFirstLossCoverContract, "CoverProviderRemoved")
                        .withArgs(await evaluationAgent2.getAddress())
                        .to.be.revertedWithCustomError(
                            adminFirstLossCoverContract,
                            "ProviderHasOutstandingAssets",
                        );
                });
            });
        });
    });

    describe("depositCover", function () {
        let assets: BN;

        beforeEach(async function () {
            assets = toToken(20_000);
        });

        it("Should allow a cover provider to deposit assets", async function () {
            // Top up the EA's wallet and allow the first loss cover contract to transfer assets from it.
            await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(adminFirstLossCoverContract.address, assets);

            const oldSupply = await adminFirstLossCoverContract.totalSupply();
            const oldAssets = await adminFirstLossCoverContract.totalAssets();
            const expectedShares = assets.mul(oldSupply).div(oldAssets);
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
            const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );
            const oldAssetsOf = await adminFirstLossCoverContract.totalAssetsOf(
                evaluationAgent.getAddress(),
            );

            await expect(adminFirstLossCoverContract.connect(evaluationAgent).depositCover(assets))
                .to.emit(adminFirstLossCoverContract, "CoverDeposited")
                .withArgs(await evaluationAgent.getAddress(), assets, expectedShares);

            expect(await adminFirstLossCoverContract.totalSupply()).to.equal(
                oldSupply.add(expectedShares),
            );
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                oldAssets.add(assets),
            );
            expect(
                await adminFirstLossCoverContract.totalAssetsOf(evaluationAgent.getAddress()),
            ).to.equal(oldAssetsOf.add(assets));
            expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                oldEABalance.sub(assets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverContractBalance.add(assets));
        });

        it("Should disallow 0 as the asset amount", async function () {
            await expect(
                adminFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(ethers.constants.Zero),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "ZeroAmountProvided");
        });

        it("Should disallow non-cover providers to make deposits", async function () {
            await expect(
                adminFirstLossCoverContract.connect(lender).depositCover(assets),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "CoverProviderRequired");
        });

        it("Should disallow deposits with amounts lower than the min requirement", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();
            await expect(
                adminFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(poolSettings.minDepositAmount.sub(toToken(1))),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "DepositAmountTooLow");
        });

        it("Should disallow deposits that exceed the max liquidity requirement", async function () {
            const maxLiquidity = await adminFirstLossCoverContract.getMaxLiquidity();
            const depositAmount = maxLiquidity.add(toToken(1));
            await mockTokenContract.mint(evaluationAgent.getAddress(), depositAmount);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(adminFirstLossCoverContract.address, depositAmount);

            await expect(
                adminFirstLossCoverContract.connect(evaluationAgent).depositCover(depositAmount),
            ).to.be.revertedWithCustomError(
                adminFirstLossCoverContract,
                "FirstLossCoverLiquidityCapExceeded",
            );
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
                .approve(adminFirstLossCoverContract.address, assets);

            const oldSupply = await adminFirstLossCoverContract.totalSupply();
            const oldAssets = await adminFirstLossCoverContract.totalAssets();
            const expectedShares = assets.mul(oldSupply).div(oldAssets);
            const oldPoolFeeManagerBalance = await mockTokenContract.balanceOf(
                defaultDeployer.address,
            );
            const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                adminFirstLossCoverContract.address,
            );

            await expect(
                adminFirstLossCoverContract.depositCoverFor(assets, evaluationAgent.getAddress()),
            )
                .to.emit(adminFirstLossCoverContract, "CoverDeposited")
                .withArgs(await evaluationAgent.getAddress(), assets, expectedShares);

            expect(await adminFirstLossCoverContract.totalSupply()).to.equal(
                oldSupply.add(expectedShares),
            );
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                oldAssets.add(assets),
            );
            expect(await mockTokenContract.balanceOf(defaultDeployer.address)).to.equal(
                oldPoolFeeManagerBalance.sub(assets),
            );
            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverContractBalance.add(assets));
        });

        it("Should disallow 0 as the asset amount", async function () {
            await expect(
                adminFirstLossCoverContract.depositCoverFor(
                    ethers.constants.Zero,
                    evaluationAgent.getAddress(),
                ),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "ZeroAmountProvided");
        });

        it("Should disallow non-cover-providers as the receiver", async function () {
            await expect(
                adminFirstLossCoverContract.depositCoverFor(assets, defaultDeployer.getAddress()),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "CoverProviderRequired");
        });

        it("Should disallow non-pool owners to make deposit on behalf of the cover provider", async function () {
            await expect(
                adminFirstLossCoverContract
                    .connect(lender)
                    .depositCoverFor(assets, evaluationAgent.getAddress()),
            ).to.be.revertedWithCustomError(
                adminFirstLossCoverContract,
                "AuthorizedContractCallerRequired",
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
                adminFirstLossCoverContract.address,
            );
            const oldPoolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);

            await expect(adminFirstLossCoverContract.addCoverAssets(assets))
                .to.emit(adminFirstLossCoverContract, "AssetsAdded")
                .withArgs(assets);

            expect(
                await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
            ).to.equal(oldFirstLossCoverBalance.add(assets));
            expect(await mockTokenContract.balanceOf(poolSafeContract.address)).to.equal(
                oldPoolSafeBalance.sub(assets),
            );
        });

        it("Should disallow non-pools to add cover assets", async function () {
            await expect(
                adminFirstLossCoverContract.connect(lender).addCoverAssets(assets),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "AuthorizedContractCallerRequired",
            );
        });
    });

    describe("convertToShares", function () {
        let assets: BN;

        beforeEach(async function () {
            assets = toToken(100);
        });

        it("Should return the assets as the number of shares if the current total supply is 0", async function () {
            expect(await adminFirstLossCoverContract.convertToShares(assets)).to.equal(assets);
        });

        it("Should return the correct number of shares otherwise", async function () {
            const depositAmount = toToken(5_000);
            await mockTokenContract.mint(evaluationAgent.getAddress(), depositAmount);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(adminFirstLossCoverContract.address, depositAmount);
            await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(depositAmount);

            const currSupply = await adminFirstLossCoverContract.totalSupply();
            const currAssets = await adminFirstLossCoverContract.totalAssets();
            expect(await adminFirstLossCoverContract.convertToShares(assets)).to.equal(
                assets.mul(currSupply).div(currAssets),
            );
        });
    });

    describe("covertToAssets", function () {
        let shares: BN;

        beforeEach(async function () {
            shares = toToken(100);
        });

        it("Should return the number of shares as the amount of assets if the current total supply is 0", async function () {
            expect(await borrowerFirstLossCoverContract.totalSupply()).to.equal(0);
            expect(await borrowerFirstLossCoverContract.convertToAssets(shares)).to.equal(shares);
        });

        it("Should return the correct amount of assets otherwise", async function () {
            const depositAmount = toToken(5_000);
            await mockTokenContract.mint(evaluationAgent.getAddress(), depositAmount);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(adminFirstLossCoverContract.address, depositAmount);
            await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(depositAmount);

            const supply = await adminFirstLossCoverContract.totalSupply();
            const assets = await adminFirstLossCoverContract.totalAssets();
            expect(supply).to.be.gt(0);
            expect(await adminFirstLossCoverContract.convertToAssets(shares)).to.equal(
                shares.mul(assets).div(supply),
            );
        });
    });

    describe("totalAssetsOf", function () {
        it("Should return the total assets of the account", async function () {
            expect(await adminFirstLossCoverContract.totalAssetsOf(lender.getAddress())).to.equal(
                0,
            );
        });
    });

    describe("redeemCover", function () {
        async function depositCover(
            assets: BN,
            profit: BN = BN.from(0),
            loss: BN = BN.from(0),
            lossRecovery: BN = BN.from(0),
        ) {
            // Top up the EA's wallet and allow the first loss cover contract to transfer assets from it.
            await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(adminFirstLossCoverContract.address, assets);

            // Distribute PnL so that the LP token isn't always 1:1 with the asset
            // when PnL is non-zero.
            await creditContract.mockDistributePnL(profit, BN.from(0), BN.from(0));

            await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(assets);
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
                const minLiquidityRequired = await adminFirstLossCoverContract.getMinLiquidity();
                await depositCover(
                    minLiquidityRequired.add(assetsToRedeem),
                    profit,
                    loss,
                    lossRecovery,
                );

                const oldSupply = await adminFirstLossCoverContract.totalSupply();
                const oldAssets = await adminFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);
                const expectedAssetsToRedeem = sharesToRedeem.mul(oldAssets).div(oldSupply);
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    adminFirstLossCoverContract.address,
                );

                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                )
                    .to.emit(adminFirstLossCoverContract, "CoverRedeemed")
                    .withArgs(
                        await evaluationAgent.getAddress(),
                        await evaluationAgent.getAddress(),
                        sharesToRedeem,
                        expectedAssetsToRedeem,
                    );

                expect(await adminFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(expectedAssetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(expectedAssetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
                ).to.equal(oldFirstLossCoverContractBalance.sub(expectedAssetsToRedeem));
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

            it("Should allow the cover provider to redeem excessive assets over the liquidity cap when there is more loss than profit", async function () {
                const assetsToRedeem = toToken(5_000);
                const profit = toToken(132),
                    loss = toToken(1908),
                    lossRecovery = toToken(59);
                await testRedeemCover(assetsToRedeem, profit, loss, lossRecovery);
            });

            it("Should disallow the cover provider to redeem assets if the min liquidity requirement hasn't been satisfied", async function () {
                // Make the cap large enough so that the first loss cover total assets fall below the cover cap.
                const coverAssets = await adminFirstLossCoverContract.totalAssets();
                const minLiquidity = coverAssets.add(1);
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity,
                    },
                );
                const assetsToRedeem = toToken(5_000);

                const oldSupply = await adminFirstLossCoverContract.totalSupply();
                const oldAssets = await adminFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);

                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "PoolIsNotReadyForFirstLossCoverWithdrawal",
                );
            });

            it("Should disallow the cover provider to redeem more shares than they own", async function () {
                const minLiquidityRequired = await adminFirstLossCoverContract.getMinLiquidity();
                const assetsToRedeem = toToken(5_000);
                await depositCover(minLiquidityRequired.add(assetsToRedeem));

                const eaShares = await adminFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(eaShares.add(1), evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "InsufficientSharesForRequest",
                );
            });

            it("Should disallow the cover provider to redeem more assets than the excessive amount over the min liquidity requirement", async function () {
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: coverTotalAssets.sub(toToken(1)),
                    },
                );
                const sharesToRedeem = await adminFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "InsufficientAmountForRequest",
                );
            });

            it("Should disallow 0 as the number of shares", async function () {
                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(ethers.constants.Zero, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "ZeroAmountProvided");
            });

            it("Should disallow 0 zero as the receiver", async function () {
                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(toToken(5_000), ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "ZeroAddressProvided",
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
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: 0,
                    },
                );
                const poolSettings = await poolConfigContract.getPoolSettings();
                await depositCover(poolSettings.minDepositAmount);
                await creditContract.mockDistributePnL(profit, loss, lossRecovery);

                const oldSupply = await adminFirstLossCoverContract.totalSupply();
                const oldAssets = await adminFirstLossCoverContract.totalAssets();
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    adminFirstLossCoverContract.address,
                );

                const sharesToRedeem =
                    await adminFirstLossCoverContract.convertToShares(assetsToRedeem);
                const expectedAssetsToRedeem =
                    await adminFirstLossCoverContract.convertToAssets(sharesToRedeem);
                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(sharesToRedeem, evaluationAgent.getAddress()),
                )
                    .to.emit(adminFirstLossCoverContract, "CoverRedeemed")
                    .withArgs(
                        await evaluationAgent.getAddress(),
                        await evaluationAgent.getAddress(),
                        sharesToRedeem,
                        expectedAssetsToRedeem,
                    );

                expect(await adminFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(expectedAssetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(expectedAssetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(adminFirstLossCoverContract.address),
                ).to.equal(oldFirstLossCoverContractBalance.sub(expectedAssetsToRedeem));
            }

            beforeEach(async function () {
                await loadFixture(setFirstLossCoverWithdrawalToReady);
            });

            it("Should allow the cover provider to redeem any valid amount", async function () {
                const assetsToRedeem = toToken(1_000);
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
                const minLiquidityRequired = await adminFirstLossCoverContract.getMinLiquidity();
                const assetsToRedeem = toToken(5_000);
                await depositCover(minLiquidityRequired.add(assetsToRedeem));

                const eaShares = await adminFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(eaShares.add(1), evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "InsufficientSharesForRequest",
                );
            });

            it("Should disallow 0 as the number of shares", async function () {
                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(ethers.constants.Zero, evaluationAgent.getAddress()),
                ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "ZeroAmountProvided");
            });

            it("Should disallow 0 zero as the receiver", async function () {
                await expect(
                    adminFirstLossCoverContract
                        .connect(evaluationAgent)
                        .redeemCover(toToken(5_000), ethers.constants.AddressZero),
                ).to.be.revertedWithCustomError(
                    adminFirstLossCoverContract,
                    "ZeroAddressProvided",
                );
            });
        });
    });

    describe("Transfer", function () {
        it("Should not allow first loss cover tokens to be transferred", async function () {
            await expect(
                adminFirstLossCoverContract
                    .connect(evaluationAgent)
                    .transfer(lender.getAddress(), toToken(100)),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "UnsupportedFunction");

            await expect(
                adminFirstLossCoverContract
                    .connect(evaluationAgent)
                    .transferFrom(
                        poolOwner.getAddress(),
                        evaluationAgent.getAddress(),
                        toToken(100),
                    ),
            ).to.be.revertedWithCustomError(adminFirstLossCoverContract, "UnsupportedFunction");
        });
    });

    describe("Loss cover and recovery", function () {
        async function setCoverConfig(coverRatePerLossInBps: BN, coverCapPerLoss: BN) {
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    coverRatePerLossInBps,
                    coverCapPerLoss,
                },
            );
        }

        describe("coverLoss", function () {
            async function testCoverLoss(
                coverRatePerLossInBps: BN,
                coverCapPerLoss: BN,
                loss: BN,
            ) {
                // Make sure the available amount for cover is less than the loss.
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                await setCoverConfig(coverRatePerLossInBps, coverCapPerLoss);
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    adminFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
                    coverTotalAssets,
                );

                // Make sure the pool has enough balance to be transferred from.
                await mockTokenContract.mint(
                    adminFirstLossCoverContract.address,
                    amountLossCovered,
                );

                const remainingLoss = loss.sub(amountLossCovered);
                const oldCoveredLoss = await adminFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.add(amountLossCovered);
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(adminFirstLossCoverContract.coverLoss(loss))
                    .to.emit(adminFirstLossCoverContract, "LossCovered")
                    .withArgs(amountLossCovered, remainingLoss, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
                    oldPoolSafeAssets.add(amountLossCovered),
                );
                expect(await adminFirstLossCoverContract.coveredLoss()).to.equal(newCoveredLoss);
            }

            async function setPool() {
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            }

            beforeEach(async function () {
                await loadFixture(setPool);
            });

            it("Should allow the pool to partially cover the loss", async function () {
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                const coverRatePerLossInBps = BN.from(9_000),
                    coverCapPerLoss = coverTotalAssets.add(1_000),
                    loss = toToken(5_000);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should allow the pool to fully cover the loss", async function () {
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                const coverRatePerLossInBps = CONSTANTS.BP_FACTOR,
                    coverCapPerLoss = coverTotalAssets.add(1_000),
                    loss = coverTotalAssets.sub(1_000);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should allow the pool to cover up to the cap", async function () {
                const coverRatePerLossInBps = BN.from(9_000),
                    coverCapPerLoss = toToken(1),
                    loss = toToken(1);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should allow the pool to cover up to the total assets of the first loss cover contract", async function () {
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                const coverRatePerLossInBps = BN.from(9_000),
                    coverCapPerLoss = coverTotalAssets.add(1_000),
                    loss = coverTotalAssets.add(1_000);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should not allow non-pools to initiate loss coverage", async function () {
                await expect(
                    adminFirstLossCoverContract.connect(lender).coverLoss(toToken(1_000)),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "AuthorizedContractCallerRequired",
                );
            });
        });

        describe("recoverLoss", function () {
            let loss: BN;

            beforeEach(async function () {
                loss = toToken(9_000);
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
            });

            it("Should allow the pool to fully recover the loss", async function () {
                // Initiate loss coverage so that the loss can be recovered later,
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                await setCoverConfig(CONSTANTS.BP_FACTOR, coverTotalAssets.add(1_000));
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    adminFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
                    coverTotalAssets,
                );
                await mockTokenContract.mint(
                    adminFirstLossCoverContract.address,
                    amountLossCovered,
                );
                await adminFirstLossCoverContract.coverLoss(loss);

                // Make sure the pool safe has enough balance to be transferred from.
                const lossRecovery = loss.add(toToken(1));
                await mockTokenContract.mint(poolSafeContract.address, lossRecovery);

                const amountRecovered = minBigNumber(amountLossCovered, lossRecovery);
                const oldCoveredLoss = await adminFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.sub(amountRecovered);
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(adminFirstLossCoverContract.recoverLoss(lossRecovery))
                    .to.emit(adminFirstLossCoverContract, "LossRecovered")
                    .withArgs(amountRecovered, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
                    oldPoolSafeAssets.sub(amountRecovered),
                );
                expect(await adminFirstLossCoverContract.coveredLoss()).to.equal(newCoveredLoss);
            });

            it("Should allow the pool to partially recover the loss", async function () {
                // Initiate loss coverage so that the loss can be recovered later,
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                await setCoverConfig(CONSTANTS.BP_FACTOR, coverTotalAssets.add(1_000));
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    adminFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
                    coverTotalAssets,
                );
                await mockTokenContract.mint(
                    adminFirstLossCoverContract.address,
                    amountLossCovered,
                );
                await adminFirstLossCoverContract.coverLoss(loss);

                // Make sure the pool safe has enough balance to be transferred from.
                const lossRecovery = loss.sub(toToken(1));
                await mockTokenContract.mint(poolSafeContract.address, lossRecovery);

                const amountRecovered = minBigNumber(amountLossCovered, lossRecovery);
                const oldCoveredLoss = await adminFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.sub(amountRecovered);
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(adminFirstLossCoverContract.recoverLoss(lossRecovery))
                    .to.emit(adminFirstLossCoverContract, "LossRecovered")
                    .withArgs(amountRecovered, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
                    oldPoolSafeAssets.sub(amountRecovered),
                );
                expect(await adminFirstLossCoverContract.coveredLoss()).to.equal(newCoveredLoss);
            });

            it("Should disallow non-pool to recover loss", async function () {
                await expect(
                    adminFirstLossCoverContract.connect(lender).recoverLoss(loss),
                ).to.be.revertedWithCustomError(
                    poolConfigContract,
                    "AuthorizedContractCallerRequired",
                );
            });
        });

        describe("isSufficient", function () {
            async function depositCover(assets: BN) {
                await mockTokenContract.mint(evaluationAgent.getAddress(), assets);
                await mockTokenContract
                    .connect(evaluationAgent)
                    .approve(adminFirstLossCoverContract.address, assets);
                await adminFirstLossCoverContract.connect(evaluationAgent).depositCover(assets);
            }

            it("Should return true if the first loss cover has more balance than the min required liquidity", async function () {
                const minLiquidityRequirement = await getMinFirstLossCoverRequirement(
                    adminFirstLossCoverContract,
                    poolConfigContract,
                );
                const poolSettings = await poolConfigContract.getPoolSettings();
                await depositCover(minLiquidityRequirement.add(poolSettings.minDepositAmount));

                expect(await adminFirstLossCoverContract.isSufficient()).to.be.true;
            });

            it("Should return false if the first loss cover has less balance than the min required liquidity", async function () {
                const coverBalance = await adminFirstLossCoverContract.totalAssets();

                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: coverBalance.add(toToken(1)),
                    },
                );
                expect(await adminFirstLossCoverContract.isSufficient()).to.be.false;
            });
        });
    });

    describe("payoutYield", function () {
        it("Should pay out yield to all providers ", async function () {
            const totalAssets = await adminFirstLossCoverContract.totalAssets();
            const yieldAmount = toToken(8273);

            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: totalAssets.sub(yieldAmount),
                },
            );

            const poolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.address,
            );
            const evaluationAgentBalance = await mockTokenContract.balanceOf(
                evaluationAgent.address,
            );
            const totalShares = await adminFirstLossCoverContract.totalSupply();
            const poolOwnerTreasuryShares = await adminFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.address,
            );
            const evaluationAgentShares = await adminFirstLossCoverContract.balanceOf(
                evaluationAgent.address,
            );

            await expect(adminFirstLossCoverContract.payoutYield())
                .to.emit(adminFirstLossCoverContract, "YieldPaidOut")
                .withArgs(
                    poolOwnerTreasury.address,
                    yieldAmount.mul(poolOwnerTreasuryShares).div(totalShares),
                )
                .to.emit(adminFirstLossCoverContract, "YieldPaidOut")
                .withArgs(
                    evaluationAgent.address,
                    yieldAmount.mul(evaluationAgentShares).div(totalShares),
                );

            // Paying out yield for a second time should do nothing.
            await expect(adminFirstLossCoverContract.payoutYield()).to.not.emit(
                adminFirstLossCoverContract,
                "YieldPaidOut",
            );

            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
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

        it("Should do nothing if the yield is 0", async function () {
            const totalAssets = await adminFirstLossCoverContract.totalAssets();
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: totalAssets,
                },
            );

            await adminFirstLossCoverContract.payoutYield();

            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(totalAssets);
        });

        it("Should do nothing if a provider has no shares", async function () {
            const poolOwnerShares = await adminFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            // Let the pool owner redeem all cover assets so that their number of shares becomes 0, and consequently
            // won't be able to get any yield payout.
            await adminFirstLossCoverContract
                .connect(poolOwnerTreasury)
                .redeemCover(poolOwnerShares, poolOwnerTreasury.getAddress());
            expect(
                await adminFirstLossCoverContract.balanceOf(poolOwnerTreasury.getAddress()),
            ).to.equal(0);

            const totalAssets = await adminFirstLossCoverContract.totalAssets();
            const yieldAmount = toToken(8273);
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: totalAssets.sub(yieldAmount),
                    minLiquidity: 0,
                },
            );

            const oldPoolOwnerBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());
            await expect(adminFirstLossCoverContract.payoutYield())
                .to.emit(adminFirstLossCoverContract, "YieldPaidOut")
                .withArgs(await evaluationAgent.getAddress(), yieldAmount);
            const newPoolOwnerBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.getAddress(),
            );
            const newEABalance = await mockTokenContract.balanceOf(evaluationAgent.getAddress());

            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                totalAssets.sub(yieldAmount),
            );
            expect(newPoolOwnerBalance).to.equal(oldPoolOwnerBalance);
            expect(newEABalance).to.equal(oldEABalance.add(yieldAmount));
        });

        it("Should not allow yield payout when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(adminFirstLossCoverContract.payoutYield()).to.be.revertedWithCustomError(
                poolConfigContract,
                "ProtocolIsPaused",
            );
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(adminFirstLossCoverContract.payoutYield()).to.be.revertedWithCustomError(
                poolConfigContract,
                "PoolIsNotOn",
            );
            await poolContract.connect(poolOwner).enablePool();
        });
    });
});
