import { ethers } from "hardhat";

import { expect } from "chai";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    BaseCreditFeeManager,
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
import { overrideFirstLossCoverConfig, toToken } from "./TestUtils";
import { BigNumber as BN } from "ethers";

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
    creditFeeManagerContract: BaseCreditFeeManager;

let profit: BN;
let expectedProtocolIncome: BN, expectedPoolOwnerIncome: BN, expectedEAIncome: BN, totalFees: BN;

describe("PoolFeeManager Tests", function () {
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
            await creditContract.setRefreshPnLReturns(profit, toToken(0), toToken(0));

            // Make sure the first loss cover has room for investment.
            await overrideFirstLossCoverConfig(
                affiliateFirstLossCoverContract,
                affiliateFirstLossCoverProfitEscrowContract,
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                poolConfigContract,
                poolOwner,
                {
                    liquidityCap: toToken(1_000_000_000),
                },
            );

            // Make sure the pool safe has liquidity for fee investment.
            await mockTokenContract.mint(poolSafeContract.address, toToken(1_000_000));

            // Refresh pool proactively so that we can get the amount of investable fees, and make sure
            // it's non-zero for the test to be meaningful.
            await poolConfigContract
                .connect(poolOwner)
                .setEpochManager(defaultDeployer.getAddress());
            await poolContract.refreshPool();
            const feesInvestable =
                await poolFeeManagerContract.getAvailableFeesToInvestInFirstLossCover();
            expect(feesInvestable).to.not.equal(ethers.constants.Zero);
            await poolFeeManagerContract.connect(poolOwner).investFeesInFirstLossCover();
        }

        async function performUpdate(
            newFirstLossCoverContract: FirstLossCover,
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
                newFirstLossCoverContract.address,
                poolFeeManagerContract.address,
                tranchesPolicyContract.address,
                epochManagerContract.address,
                seniorTrancheVaultContract.address,
                juniorTrancheVaultContract.address,
                creditContract.address,
                creditFeeManagerContract.address,
            ]);
            await newPoolConfigContract.setFirstLossCover(
                CONSTANTS.AFFILIATE_FIRST_LOSS_COVER_INDEX,
                newFirstLossCoverContract.address,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 20000,
                },
                affiliateFirstLossCoverProfitEscrowContract.address,
            );
            await poolFeeManagerContract
                .connect(poolOwner)
                .setPoolConfig(newPoolConfigContract.address);
        }

        describe("When both the first loss cover and the underlying token contracts are updated", function () {
            it("Should reset the allowance of the first loss cover contract", async function () {
                const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
                const newFirstLossCoverContract = await FirstLossCover.deploy();
                await newFirstLossCoverContract.deployed();
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
                        affiliateFirstLossCoverContract.address,
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
                        affiliateFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
            });
        });

        describe("When only the first loss cover contract is updated", function () {
            it("Should reset the allowance of the first loss cover contract", async function () {
                const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
                const newFirstLossCoverContract = await FirstLossCover.deploy();
                await newFirstLossCoverContract.deployed();
                await performUpdate(newFirstLossCoverContract, mockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        affiliateFirstLossCoverContract.address,
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
                await performUpdate(affiliateFirstLossCoverContract, newMockTokenContract);

                // Make sure the old allowance has been reduced to 0, and the new allowance has been increase to uint256.max.
                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        affiliateFirstLossCoverContract.address,
                    ),
                ).to.equal(0);
                expect(
                    await newMockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        affiliateFirstLossCoverContract.address,
                    ),
                ).to.equal(ethers.constants.MaxUint256);
            });
        });

        describe("When neither the first loss cover nor the underlying token contract is updated", function () {
            it("Should not change the allowance", async function () {
                const existingAllowance = await mockTokenContract.allowance(
                    poolFeeManagerContract.address,
                    affiliateFirstLossCoverContract.address,
                );
                await performUpdate(affiliateFirstLossCoverContract, mockTokenContract);

                expect(
                    await mockTokenContract.allowance(
                        poolFeeManagerContract.address,
                        affiliateFirstLossCoverContract.address,
                    ),
                ).to.equal(existingAllowance);
            });
        });
    });

    describe("distributePoolFees", function () {
        it("Should distribute pool fees to all parties and allow them to withdraw", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            // Make sure all the fees are distributed correctly.
            await poolFeeManagerContract.distributePoolFees(profit);
            const newAccruedIncomes = await poolFeeManagerContract.getAccruedIncomes();
            expect(newAccruedIncomes.protocolIncome).to.equal(expectedProtocolIncome);
            expect(newAccruedIncomes.poolOwnerIncome).to.equal(expectedPoolOwnerIncome);
            expect(newAccruedIncomes.eaIncome).to.equal(expectedEAIncome);

            // Make sure all parties can withdraw their fees. First, mint enough tokens for distribution.
            await mockTokenContract.mint(poolSafeContract.address, totalFees);

            // Pool owner fees.
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

            // EA fees.
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
        });

        it("Should disallow non-pool to distribute pool fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).distributePoolFees(profit),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
        });
    });

    describe("calcPoolFeeDistribution", function () {
        it("Should return the remaining profit after taking out fees", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            const remainingProfit = await poolFeeManagerContract.calcPoolFeeDistribution(profit);
            expect(remainingProfit).to.equal(profit.sub(totalFees));
        });
    });

    describe("withdrawProtocolFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        // it(
        //     "Should allow the protocol owner to withdraw the fee when there is" +
        //         " no more capacity in the first loss cover for fee investment",
        //     async function () {
        //         await mockTokenContract.mint(poolSafeContract.address, expectedProtocolIncome);
        //
        //         const oldProtocolIncomeWithdrawn =
        //             await poolFeeManagerContract.protocolIncomeWithdrawn();
        //         const oldProtocolTreasuryBalance = await mockTokenContract.balanceOf(
        //             protocolTreasury.address,
        //         );
        //         await expect(
        //             poolFeeManagerContract
        //                 .connect(protocolOwner)
        //                 .withdrawProtocolFee(expectedProtocolIncome),
        //         )
        //             .to.emit(poolFeeManagerContract, "ProtocolRewardsWithdrawn")
        //             .withArgs(
        //                 protocolTreasury.address,
        //                 expectedProtocolIncome,
        //                 protocolOwner.address,
        //             );
        //         const newProtocolIncomeWithdrawn =
        //             await poolFeeManagerContract.protocolIncomeWithdrawn();
        //         const newProtocolTreasuryBalance = await mockTokenContract.balanceOf(
        //             protocolTreasury.address,
        //         );
        //         expect(newProtocolIncomeWithdrawn).to.equal(
        //             oldProtocolIncomeWithdrawn.add(expectedProtocolIncome),
        //         );
        //         expect(newProtocolTreasuryBalance).to.equal(
        //             oldProtocolTreasuryBalance.add(expectedProtocolIncome),
        //         );
        //     },
        // );

        it("Should disallow non-protocol owner owner to withdraw protocol fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(poolFeeManagerContract, "notProtocolOwner");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(protocolOwner).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "withdrawnAmountHigherThanBalance",
            );
        });
    });

    describe("withdrawPoolOwnerFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should disallow non-pool owner treasury to withdraw protocol fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwnerTreasury");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "withdrawnAmountHigherThanBalance",
            );
        });
    });

    describe("withdrawEAFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should disallow non-pool owner or EA to withdraw protocol fees", async function () {
            await expect(
                poolFeeManagerContract.connect(lender).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwnerOrEA");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                poolFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(
                poolFeeManagerContract,
                "withdrawnAmountHigherThanBalance",
            );
        });
    });

    describe("getWithdrawables", function () {
        let profit: BN;

        before(function () {
            profit = toToken(1_000);
        });

        it("Should return the remaining amount after withdrawal", async function () {
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
});
