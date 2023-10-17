import { ethers } from "hardhat";

import { expect } from "chai";
import { deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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
import { sumBNArray, toToken } from "./TestUtils";
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
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

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

    async function poolSafeTotalAssets() {
        const firstLossCoverAssets = await Promise.all(
            [borrowerFirstLossCoverContract, affiliateFirstLossCoverContract].map((contract) =>
                contract.totalAssets(),
            ),
        );
        const poolFees = await poolFeeManagerContract.getTotalAvailableFees();
        const coverAssetsAndPoolFees = sumBNArray(firstLossCoverAssets).add(poolFees);
        const poolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
        return poolSafeBalance.gt(coverAssetsAndPoolFees)
            ? poolSafeBalance.sub(coverAssetsAndPoolFees)
            : BN.from(0);
    }

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
                    riskYieldMultipliers: 0,
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
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager",
            );
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
                    riskYieldMultipliers: 0,
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
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager",
            );
        });
    });

    describe("setRedemptionReserve", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        it("Should disallow non-qualified addresses to withdraw", async function () {
            await expect(
                poolSafeContract.connect(lender).withdraw(lender.address, amount),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager",
            );
        });
    });

    describe("getAvailableLiquidity", function () {
        beforeEach(async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
        });

        it("Should return the difference between the amount of assets and the reserve", async function () {
            // const poolSafeAssets = await poolSafeTotalAssets();
            // const diff = toToken(1);
            // const reservedForRedemption = poolSafeAssets.sub(diff);
            // await poolSafeContract.setRedemptionReserve(reservedForRedemption);
            // const availableLiquidity = await poolSafeContract.getAvailableLiquidity();
            // expect(availableLiquidity).to.equal(diff);
        });

        it("Should return 0 if the reserve exceeds the amount of assets", async function () {
            // const poolSafeAssets = await poolSafeTotalAssets();
            // const diff = toToken(1);
            // const reservedForRedemption = poolSafeAssets.add(diff);
            // await poolSafeContract.setRedemptionReserve(reservedForRedemption);
            // const availableLiquidity = await poolSafeContract.getAvailableLiquidity();
            // expect(availableLiquidity).to.equal(0);
        });
    });

    describe("getAvailableReservation", function () {
        beforeEach(async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
        });

        it("Should return the amount of reserve if there are enough assets", async function () {
            // const poolSafeAssets = await poolSafeTotalAssets();
            // const reservedForRedemption = poolSafeAssets.sub(toToken(1));
            // await poolSafeContract.setRedemptionReserve(reservedForRedemption);
            // const availableReserve = await poolSafeContract.getAvailableReservation();
            // expect(availableReserve).to.equal(reservedForRedemption);
        });

        it("Should return the amount of assets if there are more reserve than assets", async function () {
            // const poolSafeAssets = await poolSafeTotalAssets();
            // const reservedForRedemption = poolSafeAssets.add(toToken(1));
            // await poolSafeContract.setRedemptionReserve(reservedForRedemption);
            // const availableReserve = await poolSafeContract.getAvailableReservation();
            // expect(availableReserve).to.equal(poolSafeAssets);
        });
    });

    describe("getPoolAssets", function () {
        it("Should return the difference between assets and the reserve if there are enough assets", async function () {
            // const poolSafeAssets = await poolSafeTotalAssets();
            // const actualPoolAssets = await poolSafeContract.getPoolAssets();
            // expect(actualPoolAssets).to.equal(poolSafeAssets);
        });

        it("Should return 0 if there are not enough assets", async function () {
            const poolSafeBalance = await mockTokenContract.balanceOf(poolSafeContract.address);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            // Make the profit large enough so that the amount of pool fees exceed the available balance in the pool safe.
            await poolFeeManagerContract.distributePoolFees(poolSafeBalance.mul(100));

            const poolAssets = await poolSafeContract.getPoolLiquidity();
            expect(poolAssets).to.equal(0);
        });
    });
});
