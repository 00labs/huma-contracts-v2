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
import { overrideFirstLossCoverConfig, toToken } from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
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
    adminFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: CreditLineManager;

let profit: BN;
let expectedProtocolIncome: BN, expectedPoolOwnerIncome: BN, expectedEAIncome: BN, totalFees: BN;

describe("PoolFeeManager Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            protocolTreasury,
            sentinelServiceAccount,
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
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
        profit = toToken(1_000);
        const protocolFeeInBps = await humaConfigContract.protocolFeeInBps();
        expectedProtocolIncome = profit.mul(protocolFeeInBps).div(CONSTANTS.BP_FACTOR);
        const remainingProfit = profit.sub(expectedProtocolIncome);
        const adminRnR = await poolConfigContract.getAdminRnR();
        expectedPoolOwnerIncome = remainingProfit
            .mul(adminRnR.rewardRateInBpsForPoolOwner)
            .div(CONSTANTS.BP_FACTOR);
        expectedEAIncome = remainingProfit
            .mul(adminRnR.rewardRateInBpsForEA)
            .div(CONSTANTS.BP_FACTOR);
        totalFees = expectedProtocolIncome.add(expectedPoolOwnerIncome).add(expectedEAIncome);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("updatePoolConfigData", function () {
        async function spendAllowance() {
            // Spend some of the allowance by investing fees into the first loss cover contract.
            const profit = toToken(500_000);
            await creditContract.mockDistributePnL(profit, toToken(0), toToken(0));

            // Make sure the first loss cover has room for investment.
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: toToken(1_000_000_000),
                },
            );

            // Make sure the pool safe has liquidity for fee investment.
            await mockTokenContract.mint(poolSafeContract.address, toToken(1_000_000));

            // Refresh pool proactively so that we can get the amount of investable fees, and make sure
            // it's non-zero for the test to be meaningful.
            await poolConfigContract
                .connect(poolOwner)
                .setEpochManager(defaultDeployer.getAddress());
            const feesInvestable =
                await poolFeeManagerContract.getAvailableFeesToInvestInFirstLossCover();
            expect(feesInvestable).to.not.equal(ethers.constants.Zero);
            await poolFeeManagerContract
                .connect(sentinelServiceAccount)
                .investFeesInFirstLossCover();
        }

        async function performUpdate(
            newFirstLossCoverContract: FirstLossCover,
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
                newFirstLossCoverContract.address,
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
                newFirstLossCoverContract.address,
                {
                    coverRatePerLossInBps: 0,
                    coverCapPerLoss: 0,
                    maxLiquidity: 0,
                    minLiquidity: 0,
                    riskYieldMultiplierInBps: 20000,
                },
            );
            await poolFeeManagerContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address);
        }

        describe("When both the first loss cover and the underlying token contracts are updated", function () {
            it("Should reset the allowance of the first loss cover contract", async function () {
                const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
                const newFirstLossCoverContract = (await deployProxyContract(
                    FirstLossCover,
                )) as FirstLossCover;
                const MockToken = await ethers.getContractFactory("MockToken");
                const newMockTokenContract = await MockToken.deploy();
                await newMockTokenContract.deployed();
                await humaConfigContract
                    .connect(protocolOwner)
                    .setLiquidityAsset(newMockTokenContract.address, true);
                await performUpdate(newFirstLossCoverContract, newMockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        newFirstLossCoverContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
                // Make sure there is no allowance for the new pool in the old token contract, or the old pool in the
                // new token contract.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        newFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
            });
        });

        describe("When only the first loss cover contract is updated", function () {
            it("Should reset the allowance of the first loss cover contract", async function () {
                const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
                const newFirstLossCoverContract = (await deployProxyContract(
                    FirstLossCover,
                )) as FirstLossCover;
                await performUpdate(newFirstLossCoverContract, mockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        newFirstLossCoverContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When only the underlying token contract is updated", function () {
            it("Should reset the allowance of the first loss cover contract", async function () {
                const MockToken = await ethers.getContractFactory("MockToken");
                const newMockTokenContract = await MockToken.deploy();
                await newMockTokenContract.deployed();
                await humaConfigContract
                    .connect(protocolOwner)
                    .setLiquidityAsset(newMockTokenContract.address, true);
                await performUpdate(adminFirstLossCoverContract, newMockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When neither the first loss cover nor the underlying token contract is updated", function () {
            it("Should not change the allowance", async function () {
                const existingAllowance = await mockTokenContract.allowance(
                    poolFeeManagerContract.address,
                    adminFirstLossCoverContract.address,
                );
                await performUpdate(adminFirstLossCoverContract, mockTokenContract);

                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        adminFirstLossCoverContract.address,
                    ),
                ).to.equal(existingAllowance);
            });
        });
    });

    describe("distributePoolFees", function () {
        it("Should distribute pool fees to all parties", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            // Make sure all the fees are distributed correctly.
            await poolFeeManagerContract.distributePoolFees(profit);
            const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            expect(newAccruedIncomes.protocolIncome).to.equal(expectedProtocolIncome);
            expect(newAccruedIncomes.poolOwnerIncome).to.equal(expectedPoolOwnerIncome);
            expect(newAccruedIncomes.eaIncome).to.equal(expectedEAIncome);
        });

        it("Should disallow non-pool to distribute pool fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).distributePoolFees(profit),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "AuthorizedContractCallerRequired",
            );
        });
    });

    describe("withdrawProtocolFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should allow the protocol owner to withdraw the fees", async function () {
            // Make the cap 0 so that there is no room to invest to make the testing of
            // this function easier.
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: 0,
                    minLiquidity: 0,
                },
            );
            // Make sure the pool safe has enough liquidity for withdrawal.
            await mockTokenContract.mint(poolSafeContract.address, expectedProtocolIncome);
            // Distribute pool fees so that they can be withdrawn.
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolFeeManagerContract.distributePoolFees(profit);

            const oldProtocolIncomeWithdrawn =
                await poolFeeManagerContract.protocolIncomeWithdrawn();
            const oldProtocolTreasuryBalance = await mockTokenContract.balanceOf(
                protocolTreasury.address,
            );
            await expect(
                poolFeeManagerContract
                    .connect(protocolOwner)
                    .withdrawProtocolFee(expectedProtocolIncome),
            )
                .to.emit(poolFeeManagerContract, "ProtocolRewardsWithdrawn")
                .withArgs(protocolTreasury.address, expectedProtocolIncome, protocolOwner.address);
            const newProtocolIncomeWithdrawn =
                await poolFeeManagerContract.protocolIncomeWithdrawn();
            const newProtocolTreasuryBalance = await mockTokenContract.balanceOf(
                protocolTreasury.address,
            );
            expect(newProtocolIncomeWithdrawn).to.equal(
                oldProtocolIncomeWithdrawn.add(expectedProtocolIncome),
            );
            expect(newProtocolTreasuryBalance).to.equal(
                oldProtocolTreasuryBalance.add(expectedProtocolIncome),
            );

            // Make sure the protocol owner has withdrawn all the fees.
            const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
            expect(totalAvailableFees).to.equal(expectedPoolOwnerIncome.add(expectedEAIncome));
        });

        it("Should disallow non-protocol owner owner to withdraw protocol fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(poolFeeManagerContract, "ProtocolOwnerRequired");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(protocolOwner).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "InsufficientAmountForRequest",
            );
        });
    });

    describe("withdrawPoolOwnerFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should allow the pool owner to withdraw the fees", async function () {
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: 0,
                    minLiquidity: 0,
                },
            );
            // Make sure the pool safe has enough liquidity for withdrawal.
            await mockTokenContract.mint(poolSafeContract.address, expectedPoolOwnerIncome);
            // Distribute pool fees so that they can be withdrawn.
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolFeeManagerContract.distributePoolFees(profit);

            const oldPoolOwnerIncomeWithdrawn =
                await poolFeeManagerContract.poolOwnerIncomeWithdrawn();
            const oldPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.address,
            );
            await expect(
                poolFeeManagerContract
                    .connect(poolOwnerTreasury)
                    .withdrawPoolOwnerFee(expectedPoolOwnerIncome),
            )
                .to.emit(poolFeeManagerContract, "PoolRewardsWithdrawn")
                .withArgs(
                    poolOwnerTreasury.address,
                    expectedPoolOwnerIncome,
                    poolOwnerTreasury.address,
                );
            const newPoolOwnerIncomeWithdrawn =
                await poolFeeManagerContract.poolOwnerIncomeWithdrawn();
            const newPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.address,
            );
            expect(newPoolOwnerIncomeWithdrawn).to.equal(
                oldPoolOwnerIncomeWithdrawn.add(expectedPoolOwnerIncome),
            );
            expect(newPoolOwnerTreasuryBalance).to.equal(
                oldPoolOwnerTreasuryBalance.add(expectedPoolOwnerIncome),
            );

            // Make sure the pool owner has withdrawn all the fees.
            const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
            expect(totalAvailableFees).to.equal(expectedProtocolIncome.add(expectedEAIncome));
        });

        it(
            "Should disallow the pool owner treasury to withdraw pool owner fees" +
                " if the first loss cover is insufficient",
            async function () {
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
                    poolFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount),
                ).to.be.revertedWithCustomError(poolConfigContract, "InsufficientFirstLossCover");
            },
        );

        it("Should disallow non-pool owner treasury to withdraw pool owner fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "AuthorizedContractCallerRequired",
            );
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "InsufficientAmountForRequest",
            );
        });
    });

    describe("withdrawEAFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should allow the EA to withdraw the fees", async function () {
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: 0,
                    minLiquidity: 0,
                },
            );
            // Make sure the pool safe has enough liquidity for withdrawal.
            await mockTokenContract.mint(poolSafeContract.address, expectedEAIncome);
            // Distribute pool fees so that they can be withdrawn.
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolFeeManagerContract.distributePoolFees(profit);

            const oldEAIncomeWithdrawn = await poolFeeManagerContract.eaIncomeWithdrawn();
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            await expect(
                poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(expectedEAIncome),
            )
                .to.emit(poolFeeManagerContract, "EvaluationAgentRewardsWithdrawn")
                .withArgs(evaluationAgent.address, expectedEAIncome, evaluationAgent.address);
            const newEAIncomeWithdrawn = await poolFeeManagerContract.eaIncomeWithdrawn();
            const newEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            expect(newEAIncomeWithdrawn).to.equal(oldEAIncomeWithdrawn.add(expectedEAIncome));
            expect(newEABalance).to.equal(oldEABalance.add(expectedEAIncome));

            // Make sure the EA has withdrawn all the fees.
            const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
            expect(totalAvailableFees).to.equal(
                expectedProtocolIncome.add(expectedPoolOwnerIncome),
            );
        });

        it("Should disallow the EA to withdraw EA fees if the first loss cover is insufficient", async function () {
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
                poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "InsufficientFirstLossCover");
        });

        it("Should disallow non-pool owner or EA to withdraw EA fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolOwnerOrEARequired");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "InsufficientAmountForRequest",
            );
        });
    });

    describe("investFeesInFirstLossCover", function () {
        async function setPool() {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
        }

        beforeEach(async function () {
            await loadFixture(setPool);
        });

        it("Should not allow a non-pool owner and non-Sentinel Service account to invest fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).investFeesInFirstLossCover(),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "AuthorizedContractCallerRequired",
            );
        });

        it("Should allow the pool owner to not invest anything if there is no available fees to invest", async function () {
            // Zero-out the first loss cover capacity so that the fees cannot be invested.
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: 0,
                    minLiquidity: 0,
                },
            );
            await poolFeeManagerContract.distributePoolFees(profit);
            const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            const oldFirstLossCoverAssets = await adminFirstLossCoverContract.totalAssets();
            const olsPoolSafeAssets = await poolSafeContract.totalBalance();

            await poolFeeManagerContract
                .connect(sentinelServiceAccount)
                .investFeesInFirstLossCover();
            const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            expect(newAccruedIncomes.protocolIncome).to.equal(oldAccruedIncomes.protocolIncome);
            expect(newAccruedIncomes.poolOwnerIncome).to.equal(oldAccruedIncomes.poolOwnerIncome);
            expect(newAccruedIncomes.eaIncome).to.equal(oldAccruedIncomes.eaIncome);

            // Make sure that:
            // (1) the first loss cover contract doesn't get any money
            // (2) the pool fee manager contract doesn't get any money
            // (3) the pool safe contract keeps all its funds
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                oldFirstLossCoverAssets,
            );
            expect(await mockTokenContract.balanceOf(poolFeeManagerContract.address)).to.equal(0);
            expect(await poolSafeContract.totalBalance()).to.equal(olsPoolSafeAssets);
        });

        it(
            "Should allow the pool owner to invest all fees if there are fees to invest" +
                " and enough pool liquidity and first loss cover capacity",
            async function () {
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        maxLiquidity: toToken(1_000_000_000),
                        minLiquidity: 0,
                    },
                );
                await poolFeeManagerContract.distributePoolFees(profit);
                const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
                mockTokenContract.mint(poolSafeContract.address, totalAvailableFees);
                const oldFirstLossCoverAssets = await adminFirstLossCoverContract.totalAssets();
                const olsPoolSafeAssets = await poolSafeContract.totalBalance();

                await poolFeeManagerContract
                    .connect(sentinelServiceAccount)
                    .investFeesInFirstLossCover();
                const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
                expect(newAccruedIncomes.protocolIncome).to.equal(0);
                expect(newAccruedIncomes.poolOwnerIncome).to.equal(0);
                expect(newAccruedIncomes.eaIncome).to.equal(0);
                // Make sure that:
                // (1) the first loss cover contract gets all the fees
                // (2) the pool fee manager contract doesn't have any money
                // (3) the pool safe contract has the amount of fees transferred out
                expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                    oldFirstLossCoverAssets.add(totalAvailableFees),
                );
                expect(await mockTokenContract.balanceOf(poolFeeManagerContract.address)).to.equal(
                    0,
                );
                expect(await poolSafeContract.totalBalance()).to.equal(
                    olsPoolSafeAssets.sub(totalAvailableFees),
                );
            },
        );

        it(
            "Should allow the pool owner to partially invest the fees if there are fees to invest" +
                " and some pool liquidity and first loss cover capacity",
            async function () {
                const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
                await poolFeeManagerContract.distributePoolFees(profit);
                const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
                const feesLiquidity = totalAvailableFees.sub(1_000);
                // Make the first loss cover available capacity less than the total available fees.
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        maxLiquidity: coverTotalAssets.add(feesLiquidity),
                        minLiquidity: 0,
                    },
                );
                mockTokenContract.mint(poolSafeContract.address, totalAvailableFees);
                const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
                const oldFirstLossCoverAssets = await adminFirstLossCoverContract.totalAssets();
                const olsPoolSafeAssets = await poolSafeContract.totalBalance();

                // Make sure we are indeed testing the partial investment scenario.
                const expectedPoolOwnerFeesInvested = oldAccruedIncomes.poolOwnerIncome
                    .mul(feesLiquidity)
                    .div(totalAvailableFees);
                expect(expectedPoolOwnerFeesInvested).to.be.lessThan(
                    oldAccruedIncomes.poolOwnerIncome,
                );
                const expectedEAFeesInvested = oldAccruedIncomes.eaIncome
                    .mul(feesLiquidity)
                    .div(totalAvailableFees);
                expect(expectedEAFeesInvested).to.be.lessThan(oldAccruedIncomes.eaIncome);
                const expectedProtocolFeesInvested = feesLiquidity
                    .sub(expectedPoolOwnerFeesInvested)
                    .sub(expectedEAFeesInvested);
                expect(expectedProtocolFeesInvested).to.be.lessThan(
                    oldAccruedIncomes.protocolIncome,
                );

                await poolFeeManagerContract.connect(poolOwner).investFeesInFirstLossCover();
                const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
                expect(newAccruedIncomes.protocolIncome).to.equal(
                    oldAccruedIncomes.protocolIncome.sub(expectedProtocolFeesInvested),
                );
                expect(newAccruedIncomes.poolOwnerIncome).to.equal(
                    oldAccruedIncomes.poolOwnerIncome.sub(expectedPoolOwnerFeesInvested),
                );
                expect(newAccruedIncomes.eaIncome).to.equal(
                    oldAccruedIncomes.eaIncome.sub(expectedEAFeesInvested),
                );
                // Make sure that:
                // (1) the first loss cover contract gets all the fees invested
                // (2) the pool fee manager contract doesn't have any money
                // (3) the pool safe contract has the amount of fees invested transferred out
                const totalFeesInvested = expectedProtocolFeesInvested
                    .add(expectedPoolOwnerFeesInvested)
                    .add(expectedEAFeesInvested);
                expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                    oldFirstLossCoverAssets.add(totalFeesInvested),
                );
                expect(await mockTokenContract.balanceOf(poolFeeManagerContract.address)).to.equal(
                    0,
                );
                expect(await poolSafeContract.totalBalance()).to.equal(
                    olsPoolSafeAssets.sub(totalFeesInvested),
                );
            },
        );

        it("Should allow Sentinel Service account to invest fees", async function () {
            const coverTotalAssets = await adminFirstLossCoverContract.totalAssets();
            await poolFeeManagerContract.distributePoolFees(profit);
            const totalAvailableFees = await poolFeeManagerContract.getTotalAvailableFees();
            const feesLiquidity = totalAvailableFees.sub(1_000);
            // Make the first loss cover available capacity less than the total available fees.
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: coverTotalAssets.add(feesLiquidity),
                    minLiquidity: 0,
                },
            );
            mockTokenContract.mint(poolSafeContract.address, totalAvailableFees);
            const oldAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            const oldFirstLossCoverAssets = await adminFirstLossCoverContract.totalAssets();
            const olsPoolSafeAssets = await poolSafeContract.totalBalance();

            // Make sure we are indeed testing the partial investment scenario.
            const expectedPoolOwnerFeesInvested = oldAccruedIncomes.poolOwnerIncome
                .mul(feesLiquidity)
                .div(totalAvailableFees);
            expect(expectedPoolOwnerFeesInvested).to.be.lessThan(
                oldAccruedIncomes.poolOwnerIncome,
            );
            const expectedEAFeesInvested = oldAccruedIncomes.eaIncome
                .mul(feesLiquidity)
                .div(totalAvailableFees);
            expect(expectedEAFeesInvested).to.be.lessThan(oldAccruedIncomes.eaIncome);
            const expectedProtocolFeesInvested = feesLiquidity
                .sub(expectedPoolOwnerFeesInvested)
                .sub(expectedEAFeesInvested);
            expect(expectedProtocolFeesInvested).to.be.lessThan(oldAccruedIncomes.protocolIncome);

            await poolFeeManagerContract
                .connect(sentinelServiceAccount)
                .investFeesInFirstLossCover();
            const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            expect(newAccruedIncomes.protocolIncome).to.equal(
                oldAccruedIncomes.protocolIncome.sub(expectedProtocolFeesInvested),
            );
            expect(newAccruedIncomes.poolOwnerIncome).to.equal(
                oldAccruedIncomes.poolOwnerIncome.sub(expectedPoolOwnerFeesInvested),
            );
            expect(newAccruedIncomes.eaIncome).to.equal(
                oldAccruedIncomes.eaIncome.sub(expectedEAFeesInvested),
            );
            // Make sure that:
            // (1) the first loss cover contract gets all the fees invested
            // (2) the pool fee manager contract doesn't have any money
            // (3) the pool safe contract has the amount of fees invested transferred out
            const totalFeesInvested = expectedProtocolFeesInvested
                .add(expectedPoolOwnerFeesInvested)
                .add(expectedEAFeesInvested);
            expect(await adminFirstLossCoverContract.totalAssets()).to.equal(
                oldFirstLossCoverAssets.add(totalFeesInvested),
            );
            expect(await mockTokenContract.balanceOf(poolFeeManagerContract.address)).to.equal(0);
            expect(await poolSafeContract.totalBalance()).to.equal(
                olsPoolSafeAssets.sub(totalFeesInvested),
            );
        });
    });

    describe("getWithdrawables", function () {
        let profit: BN;

        before(function () {
            profit = toToken(1_000);
        });

        it("Should return the remaining amount after withdrawal", async function () {
            // Set the max liquidity to be 0 so that admins can withdraw however much they want.
            await overrideFirstLossCoverConfig(
                adminFirstLossCoverContract,
                CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    maxLiquidity: 0,
                },
            );
            const expectedFees = {
                protocolIncome: toToken(100),
                poolOwnerIncome: toToken(18),
                eaIncome: toToken(27),
            };
            const totalFees = Object.values(expectedFees).reduce(
                (acc, value) => acc.add(value),
                BN.from(0),
            );
            const withdrawalAmount = toToken(1);

            await mockTokenContract.mint(poolSafeContract.address, totalFees);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolFeeManagerContract.distributePoolFees(profit);

            await poolFeeManagerContract
                .connect(protocolOwner)
                .withdrawProtocolFee(withdrawalAmount);
            await poolFeeManagerContract
                .connect(poolOwnerTreasury)
                .withdrawPoolOwnerFee(withdrawalAmount);
            await poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(withdrawalAmount);
            const withdrawables = await poolFeeManagerContract.getWithdrawables();
            expect(withdrawables[0]).to.equal(expectedProtocolIncome.sub(withdrawalAmount));
            expect(withdrawables[1]).to.equal(expectedPoolOwnerIncome.sub(withdrawalAmount));
            expect(withdrawables[2]).to.equal(expectedEAIncome.sub(withdrawalAmount));
        });
    });

    describe("getAvailableFeesToInvestInFirstLossCover", function () {
        async function setPool() {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
        }

        beforeEach(async function () {
            await loadFixture(setPool);
        });

        it(
            "Should return the available fees as-is if there is enough capacity in the first loss cover" +
                " and liquidity in the pool",
            async function () {
                // Make sure there are incomes available.
                await poolFeeManagerContract.distributePoolFees(profit);
                const availableIncomes = await poolFeeManagerContract.getTotalAvailableFees();
                // Make sure the first loss cover cap is large enough.
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        maxLiquidity: toToken(1_000_000_000),
                        minLiquidity: 0,
                    },
                );
                // Make sure the pool has more than enough liquidity.
                mockTokenContract.mint(poolSafeContract.address, availableIncomes);

                expect(
                    await poolFeeManagerContract.getAvailableFeesToInvestInFirstLossCover(),
                ).to.equal(availableIncomes);
            },
        );

        it(
            "Should return the available cap if there is not enough capacity in the first loss cover" +
                " to invest all of the available fees",
            async function () {
                // Make sure there are incomes available.
                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
                await poolFeeManagerContract.distributePoolFees(profit);
                const availableIncomes = await poolFeeManagerContract.getTotalAvailableFees();
                // Make sure the first loss cover cap is large enough.
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        maxLiquidity: 0,
                        minLiquidity: 0,
                    },
                );
                // Make sure the pool has more than enough liquidity.
                mockTokenContract.mint(poolSafeContract.address, availableIncomes);

                expect(
                    await poolFeeManagerContract.getAvailableFeesToInvestInFirstLossCover(),
                ).to.equal(0);
            },
        );

        it(
            "Should return the available liquidity in the pool" +
                " if it's less than the available fees",
            async function () {
                // Make the fee % unrealistically large to ensure that the amount of pool fees
                // exceed the total liquidity in the pool, which in turn makes testing easier.
                await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(0, 0);
                await poolConfigContract
                    .connect(poolOwner)
                    .setPoolOwnerRewardsAndLiquidity(CONSTANTS.BP_FACTOR, 0);

                await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
                const poolLiquidity = await poolSafeContract.getAvailableBalanceForFees();
                await poolFeeManagerContract.distributePoolFees(poolLiquidity.add(1));
                const availableIncomes = await poolFeeManagerContract.getTotalAvailableFees();
                // Make sure the first loss cover cap is large enough.
                await overrideFirstLossCoverConfig(
                    adminFirstLossCoverContract,
                    CONSTANTS.ADMIN_LOSS_COVER_INDEX,
                    poolConfigContract,
                    poolOwner,
                    {
                        maxLiquidity: toToken(1_000_000_000),
                        minLiquidity: 0,
                    },
                );

                expect(
                    await poolFeeManagerContract.getAvailableFeesToInvestInFirstLossCover(),
                ).to.equal(poolLiquidity);
            },
        );
    });
});
