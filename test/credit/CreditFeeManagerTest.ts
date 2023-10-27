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
} from "../../typechain-types";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "../BaseTest";
import { toToken } from "../TestUtils";

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
    creditFeeManagerContract: CreditFeeManager;

describe("CreditFeeManager Tests", function () {
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
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("accruedDebt", function () {
        // TODO(jiatu): fill this in
    });

    describe("calcYieldDuePerPeriod", function () {
        let lateFeeFlat: BN, lateFeeBps: number, membershipFee: BN;
        let principal: BN, baseYieldInBps: number, periodDuration: number;

        async function setFeeStructure() {
            // Assign some non-zero values to make the test non-trivial.
            lateFeeFlat = toToken(100);
            lateFeeBps = 500;
            membershipFee = toToken(50);
            principal = toToken(1_000_000);
            baseYieldInBps = 1_200;
            periodDuration = 3;
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps: 0,
                minPrincipalRateInBps: 0,
                lateFeeFlat,
                lateFeeBps,
                membershipFee,
            });
        }

        beforeEach(async function () {
            await loadFixture(setFeeStructure);
        });

        it("Should account for the late fee if the bill is late", async function () {
            const expectedYieldDue = principal
                .mul(baseYieldInBps + lateFeeBps)
                .mul(periodDuration)
                .div(CONSTANTS.BP_FACTOR)
                .div(12)
                .add(lateFeeFlat)
                .add(membershipFee);
            expect(
                await creditFeeManagerContract.calcYieldDuePerPeriod(
                    principal,
                    baseYieldInBps,
                    periodDuration,
                    true,
                ),
            ).to.equal(expectedYieldDue);
        });

        it("Should not account for the late fee if the bill is current", async function () {
            const expectedYieldDue = principal
                .mul(baseYieldInBps)
                .mul(periodDuration)
                .div(CONSTANTS.BP_FACTOR)
                .div(12)
                .add(membershipFee);
            expect(
                await creditFeeManagerContract.calcYieldDuePerPeriod(
                    principal,
                    baseYieldInBps,
                    periodDuration,
                    false,
                ),
            ).to.equal(expectedYieldDue);
        });
    });

    describe("calcFrontLoadingFee", function () {
        let amount: BN;

        before(function () {
            amount = toToken(1_000);
        });

        it("Should return the correct front loading fees if there is a variable component", async function () {
            const frontLoadingFeeFlat = toToken(5),
                frontLoadingFeeBps = 500;
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat,
                frontLoadingFeeBps,
            });
            const expectedFrontLoadingFees = frontLoadingFeeFlat.add(
                amount.mul(frontLoadingFeeBps).div(CONSTANTS.BP_FACTOR),
            );
            expect(await creditFeeManagerContract.calcFrontLoadingFee(amount)).to.equal(
                expectedFrontLoadingFees,
            );
        });

        it("Should return the correct front loading fees if there is no variable component", async function () {
            const frontLoadingFeeFlat = toToken(5),
                frontLoadingFeeBps = 0;
            await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                frontLoadingFeeFlat,
                frontLoadingFeeBps,
            });
            expect(await creditFeeManagerContract.calcFrontLoadingFee(amount)).to.equal(
                frontLoadingFeeFlat,
            );
        });

        describe("distBorrowingAmount", function () {
            let frontLoadingFeeFlat: BN;

            async function setFrontLoadingFee() {
                frontLoadingFeeFlat = toToken(10);
                await poolConfigContract.connect(poolOwner).setFrontLoadingFees({
                    frontLoadingFeeFlat,
                    frontLoadingFeeBps: 0,
                });
            }

            beforeEach(async function () {
                await loadFixture(setFrontLoadingFee);
            });

            it("Should return the correct amount to the borrower and the platform fees", async function () {
                const borrowAmount = toToken(100);
                const amounts = await creditFeeManagerContract.distBorrowingAmount(borrowAmount);
                expect(amounts[0]).to.equal(borrowAmount.sub(frontLoadingFeeFlat));
                expect(amounts[1]).to.equal(frontLoadingFeeFlat);
            });

            it("Should revert if the borrow amount is less than the platform fees", async function () {
                const borrowAmount = toToken(9);
                await expect(
                    creditFeeManagerContract.distBorrowingAmount(borrowAmount),
                ).to.be.revertedWithCustomError(
                    creditFeeManagerContract,
                    "borrowingAmountLessThanPlatformFees",
                );
            });
        });
    });
});
