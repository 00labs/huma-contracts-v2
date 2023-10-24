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
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { toToken } from "./TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    protocolTreasury: SignerWithAddress,
    lender: SignerWithAddress,
    borrower: SignerWithAddress;

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

describe("PoolSafe Tests", function () {
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
            borrower,
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
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("deposit", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        async function testDeposit() {
            await mockTokenContract.mint(lender.address, amount);
            await mockTokenContract.connect(lender).approve(poolSafeContract.address, amount);

            const oldBalance = await poolSafeContract.totalLiquidity();
            await poolSafeContract.deposit(lender.address, amount);
            const newBalance = await poolSafeContract.totalLiquidity();
            expect(newBalance).to.equal(oldBalance.add(amount));
        }

        it("Should allow tranche vaults to make deposit into the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testDeposit();
        });

        it("Should allow first loss covers to make deposit into the safe", async function () {
            await poolConfigContract.connect(poolOwner).setFirstLossCover(
                1,
                defaultDeployer.address,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                },
                affiliateFirstLossCoverProfitEscrowContract.address,
            );
            await testDeposit();
        });

        it("Should allow the credit contract to make deposit into the safe", async function () {
            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.address);
            await testDeposit();
        });

        it("Should allow the pool fee manager contract to make deposit into the safe", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFeeManager(defaultDeployer.address);
            await testDeposit();
        });

        it("Should disallow non-qualified addresses to make deposits", async function () {
            await expect(
                poolSafeContract.connect(lender).deposit(lender.address, amount),
            ).to.be.revertedWithCustomError(poolSafeContract, "notAuthorizedCaller");
        });
    });

    describe("withdraw", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        async function testWithdrawal() {
            await mockTokenContract.mint(poolSafeContract.address, amount);

            const oldBalance = await poolSafeContract.totalLiquidity();
            await poolSafeContract.withdraw(lender.address, amount);
            const newBalance = await poolSafeContract.totalLiquidity();
            expect(newBalance).to.equal(oldBalance.sub(amount));
        }

        it("Should allow tranche vaults to withdraw from the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should allow first loss covers to withdraw from the safe", async function () {
            await poolConfigContract.connect(poolOwner).setFirstLossCover(
                1,
                defaultDeployer.address,
                {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                },
                affiliateFirstLossCoverProfitEscrowContract.address,
            );
            await testWithdrawal();
        });

        it("Should allow the credit contract to withdraw from the safe", async function () {
            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should allow the pool fee manager contract to make deposit into the safe", async function () {
            await poolConfigContract.connect(poolOwner).setPoolFeeManager(defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should disallow non-qualified addresses to withdraw", async function () {
            await expect(
                poolSafeContract.connect(lender).withdraw(lender.address, amount),
            ).to.be.revertedWithCustomError(poolSafeContract, "notAuthorizedCaller");
        });
    });

    describe("getPoolLiquidity", function () {
        async function setPool() {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.getAddress());
        }

        beforeEach(async function () {
            await loadFixture(setPool);
        });

        it("Should return the difference between the amount of underlying tokens and the reserve", async function () {
            // Distribute some pool fees so that the amount of reserve is non-zero.
            const profit = toToken(1_000);
            await poolFeeManagerContract.distributePoolFees(profit);
            const totalLiquidity = await poolSafeContract.totalLiquidity();
            const poolFees = await poolFeeManagerContract.getTotalAvailableFees();
            expect(await poolSafeContract.getPoolLiquidity()).to.equal(
                totalLiquidity.sub(poolFees),
            );
        });

        it("Should return 0 if the reserve exceeds the amount of underlying tokens", async function () {
            const totalLiquidity = await poolSafeContract.totalLiquidity();
            // Make the fee % unrealistically large to ensure that the amount of pool fees
            // exceed the total liquidity in the pool, which in turn makes testing easier.
            await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(0, 0);
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerRewardsAndLiquidity(CONSTANTS.BP_FACTOR, 0);
            const profit = totalLiquidity.add(1);
            await poolFeeManagerContract.distributePoolFees(profit);
            expect(await poolSafeContract.getPoolLiquidity()).to.equal(ethers.constants.Zero);
        });
    });

    describe("totalLiquidity", function () {
        it("Should return the amount of underlying tokens", async function () {
            expect(await poolSafeContract.totalLiquidity()).to.equal(
                await mockTokenContract.balanceOf(poolSafeContract.address),
            );
        });
    });

    describe("getAvailableLiquidityForFees", function () {
        it(
            "Should return the difference between the amount of underlying tokens and" +
                " the amount reserved for first loss covers",
            async function () {
                await poolConfigContract
                    .connect(poolOwner)
                    .setPoolFeeManager(defaultDeployer.getAddress());
                await poolContract.refreshPool();
                const totalLiquidity = await poolSafeContract.totalLiquidity();
                const amountReserved = await poolContract.getReservedAssetsForFirstLossCovers();
                expect(await poolSafeContract.getAvailableLiquidityForFees()).to.equal(
                    totalLiquidity.sub(amountReserved),
                );
            },
        );

        it("Should return 0 if the reserve exceeds the amount of assets", async function () {
            const profit = toToken(1_000_000);
            await creditContract.setRefreshPnLReturns(profit, toToken(0), toToken(0));
            // Withdraw assets away from pool safe so that the liquidity falls below the amount of reserve.
            await poolConfigContract
                .connect(poolOwner)
                .setPoolFeeManager(defaultDeployer.getAddress());
            const totalLiquidity = await poolSafeContract.totalLiquidity();
            await poolSafeContract.withdraw(defaultDeployer.getAddress(), totalLiquidity);
            expect(await poolSafeContract.getAvailableLiquidityForFees()).to.equal(
                ethers.constants.Zero,
            );
        });
    });
});
