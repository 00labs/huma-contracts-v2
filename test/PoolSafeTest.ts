import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import {
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
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

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
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            creditDueManagerContract,
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

    describe("deposit", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        async function testDeposit() {
            await mockTokenContract.mint(lender.address, amount);
            await mockTokenContract.connect(lender).approve(poolSafeContract.address, amount);

            const oldBalance = await poolSafeContract.totalBalance();
            await poolSafeContract.deposit(lender.address, amount);
            const newBalance = await poolSafeContract.totalBalance();
            expect(newBalance).to.equal(oldBalance.add(amount));
        }

        it("Should allow tranche vaults to make deposit into the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testDeposit();
        });

        it("Should allow first loss covers to make deposit into the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(1, defaultDeployer.address, {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                });
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

            const oldBalance = await poolSafeContract.totalBalance();
            await poolSafeContract.withdraw(lender.address, amount);
            const newBalance = await poolSafeContract.totalBalance();
            expect(newBalance).to.equal(oldBalance.sub(amount));
        }

        it("Should allow tranche vaults to withdraw from the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should allow first loss covers to withdraw from the safe", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(1, defaultDeployer.address, {
                    coverRateInBps: 0,
                    coverCap: 0,
                    liquidityCap: 0,
                    maxPercentOfPoolValueInBps: 0,
                    riskYieldMultiplier: 0,
                });
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

    describe("getPoolBalance", function () {
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
            const totalBalance = await poolSafeContract.totalBalance();
            const poolFees = await poolFeeManagerContract.getTotalAvailableFees();
            expect(await poolSafeContract.getPoolBalance()).to.equal(totalBalance.sub(poolFees));
        });

        it("Should return 0 if the reserve exceeds the amount of underlying tokens", async function () {
            const totalBalance = await poolSafeContract.totalBalance();
            // Make the fee % unrealistically large to ensure that the amount of pool fees
            // exceed the total liquidity in the pool, which in turn makes testing easier.
            await poolConfigContract.connect(poolOwner).setEARewardsAndLiquidity(0, 0);
            await poolConfigContract
                .connect(poolOwner)
                .setPoolOwnerRewardsAndLiquidity(CONSTANTS.BP_FACTOR, 0);
            const profit = totalBalance.add(1);
            await poolFeeManagerContract.distributePoolFees(profit);
            expect(await poolSafeContract.getPoolBalance()).to.equal(ethers.constants.Zero);
        });
    });

    describe("totalBalance", function () {
        it("Should return the amount of underlying tokens", async function () {
            expect(await poolSafeContract.totalBalance()).to.equal(
                await mockTokenContract.balanceOf(poolSafeContract.address),
            );
        });
    });

    describe("getAvailableLiquidityForFees", function () {
        it("Should return 0 if the reserve exceeds the amount of assets", async function () {
            const profit = toToken(1_000_000);
            await creditContract.mockDistributePnL(profit, toToken(0), toToken(0));
            // Withdraw assets away from pool safe so that the liquidity falls below the amount of reserve.
            await poolConfigContract
                .connect(poolOwner)
                .setPoolFeeManager(defaultDeployer.getAddress());
            const totalBalance = await poolSafeContract.totalBalance();
            await poolSafeContract.withdraw(defaultDeployer.getAddress(), totalBalance);
            expect(await poolSafeContract.getAvailableLiquidityForFees()).to.equal(
                ethers.constants.Zero,
            );
        });
    });
});
