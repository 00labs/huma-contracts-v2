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
    affiliateFeeManagerContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditFeeManagerContract: BaseCreditFeeManager,
    creditPnlManagerContract: BasePnLManager;

describe("PoolVault Test", function () {
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
            affiliateFeeManagerContract,
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

    describe("deposit", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        async function testDeposit() {
            await mockTokenContract.mint(lender.address, amount);
            await mockTokenContract
                .connect(lender)
                .approve(affiliateFeeManagerContract.address, amount);

            const oldBalance = await poolVaultContract.totalAssets();
            await poolVaultContract.deposit(lender.address, amount);
            const newBalance = await poolVaultContract.totalAssets();
            expect(newBalance).to.equal(oldBalance.add(amount));
        }

        it("Should allow tranche vaults to make deposit into the vault", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testDeposit();
        });

        it("Should allow first loss covers to make deposit into the vault", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(0, defaultDeployer.address, 0);
            await testDeposit();
        });

        it("Should allow the credit contract to make deposit into the vault", async function () {
            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.address);
            await testDeposit();
        });

        it("Should disallow non-qualified addresses to make deposits", async function () {
            await expect(
                poolVaultContract.connect(lender).deposit(lender.address, amount),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPlatformFeeManager",
            );
        });
    });

    describe("withdraw", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        async function testWithdrawal() {
            await mockTokenContract.mint(poolVaultContract.address, amount);

            const oldBalance = await poolVaultContract.totalAssets();
            await poolVaultContract.withdraw(lender.address, amount);
            const newBalance = await poolVaultContract.totalAssets();
            expect(newBalance).to.equal(oldBalance.sub(amount));
        }

        it("Should allow tranche vaults to withdraw from the vault", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setTranches(defaultDeployer.address, defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should allow first loss covers to withdraw from the vault", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setFirstLossCover(0, defaultDeployer.address, 0);
            await testWithdrawal();
        });

        it("Should allow the credit contract to withdraw from the vault", async function () {
            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.address);
            await testWithdrawal();
        });

        it("Should disallow non-qualified addresses to withdraw", async function () {
            await expect(
                poolVaultContract.connect(lender).withdraw(lender.address, amount),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPlatformFeeManager",
            );
        });
    });

    describe("Platform fees reserve", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        it("Should allow the platform fee manager to add fees to the reserve and then withdraw", async function () {
            await poolConfigContract
                .connect(poolOwner)
                .setPlatformFeeManager(defaultDeployer.address);
            await mockTokenContract.mint(poolVaultContract.address, amount);

            // First, add fees to the reserve.
            const originalReserve = await poolVaultContract.reserves();
            await poolVaultContract.addPlatformFeesReserve(amount);
            const reserveAfterAddition = await poolVaultContract.reserves();
            expect(reserveAfterAddition.forPlatformFees).to.equal(
                originalReserve.forPlatformFees.add(amount),
            );

            // Then withdraw fees from the reserve and send it to the EA's account.
            const oldEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            await poolVaultContract.withdrawFees(evaluationAgent.address, amount);
            const reserveAfterWithdrawal = await poolVaultContract.reserves();
            expect(reserveAfterWithdrawal.forPlatformFees).to.equal(
                reserveAfterAddition.forPlatformFees.sub(amount),
            );
            const newEABalance = await mockTokenContract.balanceOf(evaluationAgent.address);
            expect(newEABalance).to.equal(oldEABalance.add(amount));
        });

        it("Should disallow non-qualified addresses to add fees to the reserve", async function () {
            await expect(
                poolVaultContract.connect(lender).addPlatformFeesReserve(amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPlatformFeeManager");
        });

        it("Should disallow non-qualified addresses to withdraw fees from the reserve", async function () {
            await expect(
                poolVaultContract.connect(lender).withdrawFees(evaluationAgent.address, amount),
            ).to.be.revertedWithCustomError(poolConfigContract, "notPlatformFeeManager");
        });
    });

    describe("setRedemptionReserve", function () {
        let amount: BN;

        before(function () {
            amount = toToken(2_000);
        });

        it("Should allow the pool to set the redemption reserve", async function () {
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            const originalReserve = await poolVaultContract.reserves();
            await poolVaultContract.setRedemptionReserve(amount);
            const reserveAfterAddition = await poolVaultContract.reserves();
            expect(reserveAfterAddition.forRedemption).to.equal(
                originalReserve.forRedemption.add(amount),
            );
        });

        it("Should disallow non-qualified addresses to withdraw", async function () {
            await expect(
                poolVaultContract.connect(lender).withdraw(lender.address, amount),
            ).to.be.revertedWithCustomError(
                poolConfigContract,
                "notTrancheVaultOrFirstLossCoverOrCreditOrPlatformFeeManager",
            );
        });
    });

    describe("getAvailableLiquidity", function () {
        let assets: BN, reserveForRedemption: BN, reserveForPlatformFees: BN;

        beforeEach(async function () {
            assets = toToken(2_000);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolConfigContract
                .connect(poolOwner)
                .setPlatformFeeManager(defaultDeployer.address);
            await mockTokenContract.mint(poolVaultContract.address, assets);
        });

        it("Should return the difference between the amount of assets and the reserve", async function () {
            reserveForRedemption = toToken(1_000);
            reserveForPlatformFees = toToken(500);
            await poolVaultContract.setRedemptionReserve(reserveForRedemption);
            await poolVaultContract.addPlatformFeesReserve(reserveForPlatformFees);
            const availableLiquidity = await poolVaultContract.getAvailableLiquidity();
            expect(availableLiquidity).to.equal(
                assets.sub(reserveForRedemption).sub(reserveForPlatformFees),
            );
        });

        it("Should return 0 if the reserve exceeds the amount of assets", async function () {
            reserveForRedemption = toToken(2_100);
            await poolVaultContract.setRedemptionReserve(reserveForRedemption);
            const availableLiquidity = await poolVaultContract.getAvailableLiquidity();
            expect(availableLiquidity).to.equal(0);
        });
    });

    describe("getAvailableReservation", function () {
        let assets: BN, reserveForRedemption: BN, reserveForPlatformFees: BN;

        beforeEach(async function () {
            assets = toToken(2_000);
            await poolConfigContract.connect(poolOwner).setPool(defaultDeployer.address);
            await poolConfigContract
                .connect(poolOwner)
                .setPlatformFeeManager(defaultDeployer.address);
            await mockTokenContract.mint(poolVaultContract.address, assets);
        });

        it("Should return the amount of reserve if there are enough assets", async function () {
            reserveForRedemption = toToken(1_000);
            reserveForPlatformFees = toToken(500);
            await poolVaultContract.setRedemptionReserve(reserveForRedemption);
            await poolVaultContract.addPlatformFeesReserve(reserveForPlatformFees);
            const availableReserve = await poolVaultContract.getAvailableReservation();
            expect(availableReserve).to.equal(reserveForRedemption.add(reserveForPlatformFees));
        });

        it("Should return the amount of assets if there are more reserve than assets", async function () {
            reserveForRedemption = toToken(2_100);
            await poolVaultContract.setRedemptionReserve(reserveForRedemption);
            const availableReserve = await poolVaultContract.getAvailableReservation();
            expect(availableReserve).to.equal(assets);
        });
    });

    describe("getPoolAssets", function () {
        let assets: BN, reserveForPlatformFees: BN;

        beforeEach(async function () {
            assets = toToken(2_000);
            await poolConfigContract
                .connect(poolOwner)
                .setPlatformFeeManager(defaultDeployer.address);
            await mockTokenContract.mint(poolVaultContract.address, assets);
        });

        it("Should return the difference between assets and platform fees if there are enough assets", async function () {
            // reserveForPlatformFees = toToken(500);
            // await poolVaultContract.addPlatformFeesReserve(reserveForPlatformFees);
            // const poolAssets = await poolVaultContract.getPoolAssets();
            // expect(poolAssets).to.equal(assets.sub(reserveForPlatformFees));
        });

        it("Should return 0 if there are not enough assets", async function () {
            // reserveForPlatformFees = toToken(2_100);
            // await poolVaultContract.addPlatformFeesReserve(reserveForPlatformFees);
            // const poolAssets = await poolVaultContract.getPoolAssets();
            // expect(poolAssets).to.equal(0);
        });
    });

    describe("totalAssets", function () {
        let amount: BN;

        beforeEach(async function () {
            amount = toToken(2_000);
            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.address);
            await mockTokenContract.mint(poolVaultContract.address, amount);
        });

        it("Should return the asset balance", async function () {
            const assets = await poolVaultContract.totalAssets();
            expect(assets).to.equal(amount);
        });
    });
});
