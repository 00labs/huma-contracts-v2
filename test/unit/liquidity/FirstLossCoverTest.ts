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
} from "../../../typechain-types";
import {
    CONSTANTS,
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

    describe("decimals", function () {
        it("Should return the correct number of decimals of the underlying token", async function () {
            const tokenDecimals = await mockTokenContract.decimals();
            expect(await affiliateFirstLossCoverContract.decimals()).to.equal(tokenDecimals);
        });
    });

    describe("updatePoolConfigData", function () {
        async function spendAllowance() {
            // Spend some of the allowance by covering loss in the pool.
            const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
            const coverRatePerLossInBps = BN.from(9_000),
                coverCapPerLoss = coverTotalAssets.add(1_000),
                loss = toToken(5_000);
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
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
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                affiliateFirstLossCoverContract.address,
                {
                    coverRatePerLossInBps: 0,
                    coverCapPerLoss: 0,
                    maxLiquidity: 0,
                    minLiquidity: 0,
                    riskYieldMultiplierInBps: 20000,
                },
            );
            await affiliateFirstLossCoverContract
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
                const newPoolSafeContract = (await deployProxyContract(PoolSafe)) as PoolSafe;
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

    describe("addCoverProvider and getCoverProviders", function () {
        it("Should allow the pool owner to add a cover provider", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            )
                .to.emit(affiliateFirstLossCoverContract, "CoverProviderAdded")
                .withArgs(evaluationAgent2.address);

            // Adding a second time should cause an error.
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "alreadyProvider");
            const providers = await affiliateFirstLossCoverContract.getCoverProviders();
            expect(providers.includes(await evaluationAgent2.getAddress())).to.be.true;
        });

        it("Should disallow non-pool owners to add cover providers", async function () {
            await expect(
                affiliateFirstLossCoverContract.addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
        });

        it("Should disallow the cover provider address to be the zero address", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "zeroAddressProvided",
            );
        });

        it("Should disallow cover providers to be added if the number of providers has reached capacity", async function () {
            const numExistingProviders = (
                await affiliateFirstLossCoverContract.getCoverProviders()
            ).length;
            for (let i = 0; i < 100 - numExistingProviders; ++i) {
                const provider = ethers.Wallet.createRandom();
                await affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(provider.getAddress());
            }
            await expect(
                affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress()),
            ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "tooManyProviders");
        });
    });

    describe("removeCoverProvider", function () {
        describe("When the account being removed is not a cover provider", function () {
            it("Should throw an error", async function () {
                await expect(
                    affiliateFirstLossCoverContract
                        .connect(poolOwner)
                        .removeCoverProvider(evaluationAgent2.getAddress()),
                ).to.be.revertedWithCustomError(affiliateFirstLossCoverContract, "notProvider");
            });
        });

        describe("When the account is a cover provider", function () {
            async function addCoverProvider() {
                await affiliateFirstLossCoverContract
                    .connect(poolOwner)
                    .addCoverProvider(evaluationAgent2.getAddress());
            }

            describe("If the provider has not deposited assets", function () {
                beforeEach(async function () {
                    await loadFixture(addCoverProvider);
                });

                it("Should allow the provider to be removed", async function () {
                    const oldProviders = await affiliateFirstLossCoverContract.getCoverProviders();
                    expect(oldProviders.includes(await evaluationAgent2.getAddress())).to.be.true;

                    await expect(
                        affiliateFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    )
                        .to.emit(affiliateFirstLossCoverContract, "CoverProviderRemoved")
                        .withArgs(await evaluationAgent2.getAddress());

                    // Removing a second time should cause an error.
                    await expect(
                        affiliateFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    ).to.be.revertedWithCustomError(
                        affiliateFirstLossCoverContract,
                        "notProvider",
                    );

                    const newProviders = await affiliateFirstLossCoverContract.getCoverProviders();
                    expect(newProviders.includes(await evaluationAgent2.getAddress())).to.be.false;
                });

                it("Should not allow non-pool owners to remove cover providers", async function () {
                    await expect(
                        affiliateFirstLossCoverContract
                            .connect(lender)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwner");
                });

                it("Should not remove providers with zero address", async function () {
                    await expect(
                        affiliateFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(ethers.constants.AddressZero),
                    ).to.be.revertedWithCustomError(poolConfigContract, "zeroAddressProvided");
                });
            });

            describe("If the provider has deposited assets", function () {
                let providerAssets: BN;

                async function prepare() {
                    providerAssets = toToken(10_000);

                    const currentCoverTotalAssets =
                        await affiliateFirstLossCoverContract.totalAssets();

                    await overrideFirstLossCoverConfig(
                        affiliateFirstLossCoverContract,
                        CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
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
                        .approve(affiliateFirstLossCoverContract.address, providerAssets);
                    await affiliateFirstLossCoverContract
                        .connect(evaluationAgent2)
                        .depositCover(providerAssets);
                }

                beforeEach(async function () {
                    await loadFixture(prepare);
                });

                it("Should not allow the provider to be removed", async function () {
                    await expect(
                        affiliateFirstLossCoverContract
                            .connect(poolOwner)
                            .removeCoverProvider(evaluationAgent2.getAddress()),
                    )
                        .to.emit(affiliateFirstLossCoverContract, "CoverProviderRemoved")
                        .withArgs(await evaluationAgent2.getAddress())
                        .to.be.revertedWithCustomError(
                            affiliateFirstLossCoverContract,
                            "providerHasOutstandingAssets",
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

        it("Should disallow deposits with amounts lower than the min requirement", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();
            await expect(
                affiliateFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(poolSettings.minDepositAmount.sub(toToken(1))),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "depositAmountTooLow",
            );
        });

        it("Should disallow deposits that exceed the max liquidity requirement", async function () {
            const maxLiquidity = await affiliateFirstLossCoverContract.getMaxLiquidity();
            const depositAmount = maxLiquidity.add(toToken(1));
            await mockTokenContract.mint(evaluationAgent.getAddress(), depositAmount);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(affiliateFirstLossCoverContract.address, depositAmount);

            await expect(
                affiliateFirstLossCoverContract
                    .connect(evaluationAgent)
                    .depositCover(depositAmount),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "firstLossCoverLiquidityCapExceeded",
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

        it("Should disallow deposits with amounts lower than the min requirement", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();
            await expect(
                affiliateFirstLossCoverContract.depositCoverFor(
                    poolSettings.minDepositAmount.sub(toToken(1)),
                    evaluationAgent.getAddress(),
                ),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "depositAmountTooLow",
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

    describe("convertToShares", function () {
        let assets: BN;

        beforeEach(async function () {
            assets = toToken(100);
        });

        it("Should return the assets as the number of shares if the current total supply is 0", async function () {
            expect(await affiliateFirstLossCoverContract.convertToShares(assets)).to.equal(assets);
        });

        it("Should return the correct number of shares otherwise", async function () {
            const depositAmount = toToken(5_000);
            await mockTokenContract.mint(evaluationAgent.getAddress(), depositAmount);
            await mockTokenContract
                .connect(evaluationAgent)
                .approve(affiliateFirstLossCoverContract.address, depositAmount);
            await affiliateFirstLossCoverContract
                .connect(evaluationAgent)
                .depositCover(depositAmount);

            const currSupply = await affiliateFirstLossCoverContract.totalSupply();
            const currAssets = await affiliateFirstLossCoverContract.totalAssets();
            expect(await affiliateFirstLossCoverContract.convertToShares(assets)).to.equal(
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
                .approve(affiliateFirstLossCoverContract.address, depositAmount);
            await affiliateFirstLossCoverContract
                .connect(evaluationAgent)
                .depositCover(depositAmount);

            const supply = await affiliateFirstLossCoverContract.totalSupply();
            const assets = await affiliateFirstLossCoverContract.totalAssets();
            expect(supply).to.be.gt(0);
            expect(await affiliateFirstLossCoverContract.convertToAssets(shares)).to.equal(
                shares.mul(assets).div(supply),
            );
        });
    });

    describe("totalAssetsOf", function () {
        it("Should return the total assets of the account", async function () {
            expect(
                await affiliateFirstLossCoverContract.totalAssetsOf(lender.getAddress()),
            ).to.equal(0);
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
                .approve(affiliateFirstLossCoverContract.address, assets);

            // Distribute PnL so that the LP token isn't always 1:1 with the asset
            // when PnL is non-zero.
            await creditContract.mockDistributePnL(profit, BN.from(0), BN.from(0));

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
                const minLiquidityRequired =
                    await affiliateFirstLossCoverContract.getMinLiquidity();
                await depositCover(
                    minLiquidityRequired.add(assetsToRedeem),
                    profit,
                    loss,
                    lossRecovery,
                );

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const sharesToRedeem = assetsToRedeem.mul(oldSupply).div(oldAssets);
                const expectedAssetsToRedeem = sharesToRedeem.mul(oldAssets).div(oldSupply);
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
                        expectedAssetsToRedeem,
                    );

                expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(expectedAssetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(expectedAssetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
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
                const coverAssets = await affiliateFirstLossCoverContract.totalAssets();
                const minLiquidity = coverAssets.add(1);
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity,
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
                const minLiquidityRequired =
                    await affiliateFirstLossCoverContract.getMinLiquidity();
                const assetsToRedeem = toToken(5_000);
                await depositCover(minLiquidityRequired.add(assetsToRedeem));

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

            it("Should disallow the cover provider to redeem more assets than the excessive amount over the min liquidity requirement", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: coverTotalAssets.sub(toToken(1)),
                    },
                );
                const sharesToRedeem = await affiliateFirstLossCoverContract.balanceOf(
                    evaluationAgent.getAddress(),
                );

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
                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: 0,
                    },
                );
                const poolSettings = await poolConfigContract.getPoolSettings();
                await depositCover(poolSettings.minDepositAmount);
                await creditContract.mockDistributePnL(profit, loss, lossRecovery);

                const oldSupply = await affiliateFirstLossCoverContract.totalSupply();
                const oldAssets = await affiliateFirstLossCoverContract.totalAssets();
                const oldEABalance = await mockTokenContract.balanceOf(
                    evaluationAgent.getAddress(),
                );
                const oldFirstLossCoverContractBalance = await mockTokenContract.balanceOf(
                    affiliateFirstLossCoverContract.address,
                );

                const sharesToRedeem =
                    await affiliateFirstLossCoverContract.convertToShares(assetsToRedeem);
                const expectedAssetsToRedeem =
                    await affiliateFirstLossCoverContract.convertToAssets(sharesToRedeem);
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
                        expectedAssetsToRedeem,
                    );

                expect(await affiliateFirstLossCoverContract.totalSupply()).to.equal(
                    oldSupply.sub(sharesToRedeem),
                );
                expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(
                    oldAssets.sub(expectedAssetsToRedeem),
                );
                expect(await mockTokenContract.balanceOf(evaluationAgent.getAddress())).to.equal(
                    oldEABalance.add(expectedAssetsToRedeem),
                );
                expect(
                    await mockTokenContract.balanceOf(affiliateFirstLossCoverContract.address),
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
                const minLiquidityRequired =
                    await affiliateFirstLossCoverContract.getMinLiquidity();
                const assetsToRedeem = toToken(5_000);
                await depositCover(minLiquidityRequired.add(assetsToRedeem));

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

    describe("Transfer", function () {
        it("Should not allow first loss cover tokens to be transferred", async function () {
            await expect(
                affiliateFirstLossCoverContract
                    .connect(evaluationAgent)
                    .transfer(lender.address, toToken(100)),
            ).to.be.revertedWithCustomError(
                affiliateFirstLossCoverContract,
                "unsupportedFunction",
            );
        });
    });

    describe("Loss cover and recovery", function () {
        async function setCoverConfig(coverRatePerLossInBps: BN, coverCapPerLoss: BN) {
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
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
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await setCoverConfig(coverRatePerLossInBps, coverCapPerLoss);
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
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
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(affiliateFirstLossCoverContract.coverLoss(loss))
                    .to.emit(affiliateFirstLossCoverContract, "LossCovered")
                    .withArgs(amountLossCovered, remainingLoss, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
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
                const coverRatePerLossInBps = BN.from(9_000),
                    coverCapPerLoss = coverTotalAssets.add(1_000),
                    loss = toToken(5_000);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should allow the pool to fully cover the loss", async function () {
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
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
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                const coverRatePerLossInBps = BN.from(9_000),
                    coverCapPerLoss = coverTotalAssets.add(1_000),
                    loss = coverTotalAssets.add(1_000);
                await testCoverLoss(coverRatePerLossInBps, coverCapPerLoss, loss);
            });

            it("Should not allow non-pools to initiate loss coverage", async function () {
                await expect(
                    affiliateFirstLossCoverContract.connect(lender).coverLoss(toToken(1_000)),
                ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
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
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await setCoverConfig(CONSTANTS.BP_FACTOR, coverTotalAssets.add(1_000));
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
                    coverTotalAssets,
                );
                await mockTokenContract.mint(
                    affiliateFirstLossCoverContract.address,
                    amountLossCovered,
                );
                await affiliateFirstLossCoverContract.coverLoss(loss);

                // Make sure the pool safe has enough balance to be transferred from.
                const lossRecovery = loss.add(toToken(1));
                await mockTokenContract.mint(poolSafeContract.address, lossRecovery);

                const amountRecovered = minBigNumber(amountLossCovered, lossRecovery);
                const oldCoveredLoss = await affiliateFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.sub(amountRecovered);
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(affiliateFirstLossCoverContract.recoverLoss(lossRecovery))
                    .to.emit(affiliateFirstLossCoverContract, "LossRecovered")
                    .withArgs(amountRecovered, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
                    oldPoolSafeAssets.sub(amountRecovered),
                );
                expect(await affiliateFirstLossCoverContract.coveredLoss()).to.equal(
                    newCoveredLoss,
                );
            });

            it("Should allow the pool to partially recover the loss", async function () {
                // Initiate loss coverage so that the loss can be recovered later,
                const coverTotalAssets = await affiliateFirstLossCoverContract.totalAssets();
                await setCoverConfig(CONSTANTS.BP_FACTOR, coverTotalAssets.add(1_000));
                const config = await poolConfigContract.getFirstLossCoverConfig(
                    affiliateFirstLossCoverContract.address,
                );
                const amountLossCovered = minBigNumber(
                    loss.mul(config.coverRatePerLossInBps).div(CONSTANTS.BP_FACTOR),
                    config.coverCapPerLoss,
                    coverTotalAssets,
                );
                await mockTokenContract.mint(
                    affiliateFirstLossCoverContract.address,
                    amountLossCovered,
                );
                await affiliateFirstLossCoverContract.coverLoss(loss);

                // Make sure the pool safe has enough balance to be transferred from.
                const lossRecovery = loss.sub(toToken(1));
                await mockTokenContract.mint(poolSafeContract.address, lossRecovery);

                const amountRecovered = minBigNumber(amountLossCovered, lossRecovery);
                const oldCoveredLoss = await affiliateFirstLossCoverContract.coveredLoss();
                const newCoveredLoss = oldCoveredLoss.sub(amountRecovered);
                const oldPoolSafeAssets = await poolSafeContract.totalBalance();

                await expect(affiliateFirstLossCoverContract.recoverLoss(lossRecovery))
                    .to.emit(affiliateFirstLossCoverContract, "LossRecovered")
                    .withArgs(amountRecovered, newCoveredLoss);
                expect(await poolSafeContract.totalBalance()).to.equal(
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

            it("Should return true if the first loss cover has more balance than the min required liquidity", async function () {
                const minLiquidityRequirement = await getMinFirstLossCoverRequirement(
                    affiliateFirstLossCoverContract,
                    poolConfigContract,
                );
                const poolSettings = await poolConfigContract.getPoolSettings();
                await depositCover(minLiquidityRequirement.add(poolSettings.minDepositAmount));

                expect(await affiliateFirstLossCoverContract.isSufficient()).to.be.true;
            });

            it("Should return false if the first loss cover has less balance than the min required liquidity", async function () {
                const coverBalance = await affiliateFirstLossCoverContract.totalAssets();

                await overrideFirstLossCoverConfig(
                    affiliateFirstLossCoverContract,
                    CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        minLiquidity: coverBalance.add(toToken(1)),
                    },
                );
                expect(await affiliateFirstLossCoverContract.isSufficient()).to.be.false;
            });
        });
    });

    describe("payoutYield", function () {
        it("Should do nothing if the yield is 0", async function () {
            const totalAssets = await affiliateFirstLossCoverContract.totalAssets();
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: totalAssets,
                },
            );

            await affiliateFirstLossCoverContract.payoutYield();

            expect(await affiliateFirstLossCoverContract.totalAssets()).to.equal(totalAssets);
        });

        it("Should pay out yield to all providers ", async function () {
            const totalAssets = await affiliateFirstLossCoverContract.totalAssets();
            const yieldAmount = toToken(8273);

            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
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
            const totalShares = await affiliateFirstLossCoverContract.totalSupply();
            const poolOwnerTreasuryShares = await affiliateFirstLossCoverContract.balanceOf(
                poolOwnerTreasury.address,
            );
            const evaluationAgentShares = await affiliateFirstLossCoverContract.balanceOf(
                evaluationAgent.address,
            );

            await expect(affiliateFirstLossCoverContract.payoutYield())
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
