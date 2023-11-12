import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { BigNumber as BN } from "ethers";
import { ethers } from "hardhat";
import moment from "moment";
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
} from "../../typechain-types";
import {
    CONSTANTS,
    CreditState,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "../BaseTest";
import {
    getFutureBlockTime,
    mineNextBlockWithTimestamp,
    timestampToMoment,
    toToken,
} from "../TestUtils";

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
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    creditDueManagerContract: CreditDueManager;

describe("CreditDueManager.sol Tests", function () {
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
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender],
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
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
            expect(await creditDueManagerContract.calcFrontLoadingFee(amount)).to.equal(
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
            expect(await creditDueManagerContract.calcFrontLoadingFee(amount)).to.equal(
                frontLoadingFeeFlat,
            );
        });
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
            const amounts = await creditDueManagerContract.distBorrowingAmount(borrowAmount);
            expect(amounts[0]).to.equal(borrowAmount.sub(frontLoadingFeeFlat));
            expect(amounts[1]).to.equal(frontLoadingFeeFlat);
        });

        it("Should revert if the borrow amount is less than the platform fees", async function () {
            const borrowAmount = toToken(9);
            await expect(
                creditDueManagerContract.distBorrowingAmount(borrowAmount),
            ).to.be.revertedWithCustomError(
                creditDueManagerContract,
                "borrowingAmountLessThanPlatformFees",
            );
        });
    });

    describe("checkLate", function () {
        it("Should return true if there are missed periods", async function () {
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: Date.now(),
                nextDue: 0,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            expect(await creditDueManagerContract.checkLate(creditRecord)).to.be.true;
        });

        it("Should return true if there is payment due and we've already passed the payment grace period", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();
            // Advance next block time to be a second after the end of the late payment grace period.
            const nextBlockTime = timestampToMoment(await getFutureBlockTime(0))
                .add(poolSettings.latePaymentGracePeriodInDays, "days")
                .add(1, "second");
            await mineNextBlockWithTimestamp(nextBlockTime.unix());
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: moment().unix(),
                nextDue: toToken(1_000),
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.GoodStanding,
            };
            expect(await creditDueManagerContract.checkLate(creditRecord)).to.be.true;
        });

        it("Should return false if there is no missed periods and no next due", async function () {
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: 0,
                nextDue: 0,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.Approved,
            };
            expect(await creditDueManagerContract.checkLate(creditRecord)).to.be.false;
        });

        it("Should return false if there is next due but we are not at the due date yet", async function () {
            const nextDueDate = timestampToMoment(Date.now()).add(1, "day");
            const creditRecord = {
                unbilledPrincipal: 0,
                nextDueDate: nextDueDate.unix(),
                nextDue: toToken(1_000),
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.Approved,
            };
            expect(await creditDueManagerContract.checkLate(creditRecord)).to.be.false;
        });
    });

    describe("getNextBillRefreshDate", function () {
        // TODO(jiatu): fill this in
    });

    describe("refreshLateFee", function () {
        // TODO(jiatu): fill this in
    });

    describe("getDueInfo", function () {
        // TODO(jiatu): fill this in
    });

    describe("getPayoffAmount", function () {
        it("Should return the payoff amount", async function () {
            const creditRecord = {
                unbilledPrincipal: toToken(12_345),
                nextDueDate: Date.now(),
                nextDue: toToken(54_321),
                yieldDue: 0,
                totalPastDue: toToken(7_890),
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            expect(await creditDueManagerContract.getPayoffAmount(creditRecord)).to.equal(
                creditRecord.unbilledPrincipal
                    .add(creditRecord.nextDue)
                    .add(creditRecord.totalPastDue),
            );
        });
    });
});
