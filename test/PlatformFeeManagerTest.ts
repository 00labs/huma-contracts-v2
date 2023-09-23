import { ethers } from "hardhat";

import { expect } from "chai";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "./BaseTest";
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
    PlatformFeeManager,
    Pool,
    PoolConfig,
    PoolVault,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { toToken } from "./TestUtils";
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
    platformFeeManagerContract: PlatformFeeManager,
    poolVaultContract: PoolVault,
    calendarContract: Calendar,
    borrowerFirstLossCoverContract: FirstLossCover,
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

let profit: BN;
let expectedProtocolIncome: BN, expectedPoolOwnerIncome: BN, expectedEAIncome: BN, totalFees: BN;

describe("PlatformFeeManager Test", function () {
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
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            borrowerFirstLossCoverContract,
            affiliateFirstLossCoverContract,
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

    describe("distributePlatformFees", function () {
        it("Should distribute platform fees to all parties and allow them to withdraw", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            // Make sure all the fees are distributed correctly.
            const oldReserve = await poolVaultContract.reserves();
            await platformFeeManagerContract.distributePlatformFees(profit);
            const newAccruedIncomes = await platformFeeManagerContract.getAccruedIncomes();
            const newReserve = await poolVaultContract.reserves();
            expect(newAccruedIncomes.protocolIncome).to.equal(expectedProtocolIncome);
            expect(newAccruedIncomes.poolOwnerIncome).to.equal(expectedPoolOwnerIncome);
            expect(newAccruedIncomes.eaIncome).to.equal(expectedEAIncome);
            // expect(newReserve.forPlatformFees).to.equal(oldReserve.forPlatformFees.add(totalFees));
            expect(newReserve.forRedemption).to.equal(oldReserve.forRedemption);

            // Make sure all parties can withdraw their fees. First, mint enough tokens for distribution.
            await mockTokenContract.mint(poolVaultContract.address, totalFees);

            // Protocol owner fees.
            const oldProtocolIncomeWithdrawn =
                await platformFeeManagerContract.protocolIncomeWithdrawn();
            const oldProtocolTreasuryBalance = await mockTokenContract.balanceOf(
                protocolTreasury.address,
            );
            await expect(
                platformFeeManagerContract
                    .connect(protocolOwner)
                    .withdrawProtocolFee(expectedProtocolIncome),
            )
                .to.emit(platformFeeManagerContract, "ProtocolRewardsWithdrawn")
                .withArgs(protocolTreasury.address, expectedProtocolIncome, protocolOwner.address);
            const newProtocolIncomeWithdrawn =
                await platformFeeManagerContract.protocolIncomeWithdrawn();
            const newProtocolTreasuryBalance = await mockTokenContract.balanceOf(
                protocolTreasury.address,
            );
            expect(newProtocolIncomeWithdrawn).to.equal(
                oldProtocolIncomeWithdrawn.add(expectedProtocolIncome),
            );
            expect(newProtocolTreasuryBalance).to.equal(
                oldProtocolTreasuryBalance.add(expectedProtocolIncome),
            );

            // Pool owner fees.
            const oldPoolOwnerIncomeWithdrawn =
                await platformFeeManagerContract.poolOwnerIncomeWithdrawn();
            const oldPoolOwnerTreasuryBalance = await mockTokenContract.balanceOf(
                poolOwnerTreasury.address,
            );
            await expect(
                platformFeeManagerContract
                    .connect(poolOwnerTreasury)
                    .withdrawPoolOwnerFee(expectedPoolOwnerIncome),
            )
                .to.emit(platformFeeManagerContract, "PoolRewardsWithdrawn")
                .withArgs(
                    poolOwnerTreasury.address,
                    expectedPoolOwnerIncome,
                    poolOwnerTreasury.address,
                );
            const newPoolOwnerIncomeWithdrawn =
                await platformFeeManagerContract.poolOwnerIncomeWithdrawn();
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
            const oldEAIncomeWithdrawn = await platformFeeManagerContract.eaIncomeWithdrawn();
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            await expect(
                platformFeeManagerContract
                    .connect(evaluationAgent)
                    .withdrawEAFee(expectedEAIncome),
            )
                .to.emit(platformFeeManagerContract, "EvaluationAgentRewardsWithdrawn")
                .withArgs(evaluationAgent.address, expectedEAIncome, evaluationAgent.address);
            const newEAIncomeWithdrawn = await platformFeeManagerContract.eaIncomeWithdrawn();
            const newEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            expect(newEAIncomeWithdrawn).to.equal(oldEAIncomeWithdrawn.add(expectedEAIncome));
            expect(newEABalance).to.equal(oldEABalance.add(expectedEAIncome));
        });

        it("Should disallow non-pool to distribute platform fees", async function () {
            await expect(
                platformFeeManagerContract.connect(lender).distributePlatformFees(profit),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPool");
        });
    });

    describe("calcPlatformFeeDistribution", function () {
        it("Should return the remaining profit after taking out fees", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            const remainingProfit =
                await platformFeeManagerContract.calcPlatformFeeDistribution(profit);
            expect(remainingProfit).to.equal(profit.sub(totalFees));
        });
    });

    describe("withdrawProtocolFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should disallow non-protocol owner owner to withdraw protocol fees", async function () {
            await expect(
                platformFeeManagerContract.connect(lender).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(platformFeeManagerContract, "notProtocolOwner");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                platformFeeManagerContract.connect(protocolOwner).withdrawProtocolFee(amount),
            ).to.be.revertedWithCustomError(
                platformFeeManagerContract,
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
                platformFeeManagerContract.connect(lender).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwnerTreasury");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                platformFeeManagerContract.connect(poolOwnerTreasury).withdrawPoolOwnerFee(amount),
            ).to.be.revertedWithCustomError(
                platformFeeManagerContract,
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
                platformFeeManagerContract.connect(lender).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPoolOwnerOrEA");
        });

        it("Should disallow withdrawal attempts with amounts higher than the balance", async function () {
            await expect(
                platformFeeManagerContract.connect(evaluationAgent).withdrawEAFee(amount),
            ).to.be.revertedWithCustomError(
                platformFeeManagerContract,
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

            await mockTokenContract.mint(poolVaultContract.address, totalFees);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);

            await platformFeeManagerContract.distributePlatformFees(profit);
            await platformFeeManagerContract
                .connect(protocolOwner)
                .withdrawProtocolFee(withdrawalAmount);
            await platformFeeManagerContract
                .connect(poolOwnerTreasury)
                .withdrawPoolOwnerFee(withdrawalAmount);
            await platformFeeManagerContract
                .connect(evaluationAgent)
                .withdrawEAFee(withdrawalAmount);
            const withdrawables = await platformFeeManagerContract.getWithdrawables();
            expect(withdrawables[0]).to.equal(expectedProtocolIncome.sub(withdrawalAmount));
            expect(withdrawables[1]).to.equal(expectedPoolOwnerIncome.sub(withdrawalAmount));
            expect(withdrawables[2]).to.equal(expectedEAIncome.sub(withdrawalAmount));
        });
    });
});
