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
    MockNFT,
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    ReceivableFactoringCredit,
    ReceivableFactoringCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CreditState,
    PayPeriodDuration,
    calcYield,
    calcYieldDue,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
} from "../../BaseTest";
import {
    evmRevert,
    evmSnapshot,
    receivableLevelCreditHash,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";
import { CONSTANTS } from "../../constants";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress, payer: SignerWithAddress;

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
    creditContract: ReceivableFactoringCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableFactoringCreditManager,
    nftContract: MockNFT;

describe("ReceivableFactoringCredit Integration Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            eaServiceAccount,
            sentinelServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
            borrower,
            payer,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
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
            "ReceivableFactoringCredit",
            "ReceivableFactoringCreditManager",
            evaluationAgent,
            treasury,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower, payer],
        );

        const MockNFT = await ethers.getContractFactory("MockNFT");
        nftContract = await MockNFT.deploy();
        await nftContract.deployed();

        await nftContract.initialize(mockTokenContract.address, poolSafeContract.address);
        await poolConfigContract.connect(poolOwner).setReceivableAsset(nftContract.address);
        await creditManagerContract.connect(poolOwner).addPayer(nftContract.address);
        await mockTokenContract
            .connect(payer)
            .approve(nftContract.address, ethers.constants.MaxUint256);

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        await juniorTrancheVaultContract.connect(lender).deposit(toToken(10_000_000));
    }

    describe("Bulla case tests", function () {
        let creditHash: string;
        let borrowAmount: BN, creditLimit: BN;
        const yieldInBps = 1200;
        const lateFeeBps = 2400;
        const principalRate = 0;
        const latePaymentGracePeriodInDays = 5;
        let tokenId: BN;
        let nextTimestamp: number;

        async function prepareForBullaTests() {
            borrowAmount = toToken(1_000_000);
            creditLimit = borrowAmount
                .mul(5)
                .mul(CONSTANTS.BP_FACTOR.add(500))
                .div(CONSTANTS.BP_FACTOR);

            let settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays,
                },
            });

            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: principalRate,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
        }

        let sId: unknown;

        before(async function () {
            await loadFixture(prepare);
            await loadFixture(prepareForBullaTests);
            sId = await evmSnapshot();
        });

        after(async function () {
            if (sId) {
                await evmRevert(sId);
            }
        });

        it("Approves borrower credit", async function () {
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    1,
                    yieldInBps,
                );
        });

        it("Payee draws down with receivable", async function () {
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);
        });

        it("Payee pays for the yield due due", async function () {
            const oldCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(tokenId, oldCR.yieldDue);

            const actualCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            const expectedCR = {
                unbilledPrincipal: 0,
                nextDueDate: oldCR.nextDueDate,
                nextDue: borrowAmount,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.GoodStanding,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
        });

        it("Refreshes credit after late payment grace period", async function () {
            const oldCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            nextTimestamp =
                oldCR.nextDueDate.toNumber() +
                CONSTANTS.SECONDS_IN_A_DAY * latePaymentGracePeriodInDays +
                100;
            await setNextBlockTimestamp(nextTimestamp);

            await creditManagerContract.refreshCredit(tokenId);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                nextTimestamp,
            );
            const [accruedYieldDue, committedYieldDue] = calcYieldDue(
                cc,
                borrowAmount,
                CONSTANTS.DAYS_IN_A_MONTH,
            );
            expect(accruedYieldDue).to.be.gt(committedYieldDue);
            const lateFeeUpdatedDate = await calendarContract.getStartOfNextDay(nextTimestamp);
            const daysPassed = await calendarContract.getDaysDiff(
                oldCR.nextDueDate,
                lateFeeUpdatedDate,
            );
            const lateFee = calcYield(borrowAmount, lateFeeBps, daysPassed.toNumber());
            const actualCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            const expectedCR = {
                unbilledPrincipal: 0,
                nextDueDate,
                nextDue: accruedYieldDue,
                yieldDue: accruedYieldDue,
                totalPastDue: borrowAmount.add(lateFee),
                missedPeriods: 1,
                remainingPeriods: 0,
                state: CreditState.Delayed,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedDD = genDueDetail({
                lateFeeUpdatedDate,
                lateFee,
                principalPastDue: borrowAmount,
                accrued: accruedYieldDue,
                committed: committedYieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);
        });

        it("Payer pays for the receivable in full", async function () {
            const oldCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            const oldDD = await creditContract.getDueDetail(creditHash);

            await nftContract
                .connect(payer)
                .payOwner(tokenId, oldCR.nextDue.add(oldCR.totalPastDue));

            const actualCR = await creditContract["getCreditRecord(bytes32)"](creditHash);
            const expectedCR = {
                unbilledPrincipal: 0,
                nextDueDate: oldCR.nextDueDate,
                nextDue: 0,
                yieldDue: 0,
                totalPastDue: 0,
                missedPeriods: 0,
                remainingPeriods: 0,
                state: CreditState.Deleted,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedDD = genDueDetail({
                accrued: oldDD.accrued,
                committed: oldDD.committed,
                paid: oldCR.yieldDue,
            });
            checkDueDetailsMatch(actualDD, expectedDD);
        });
    });
});
