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
    CreditClosureReason,
    CreditState,
    PayPeriodDuration,
    calcYield,
    calcYieldDue,
    checkCreditConfigsMatch,
    checkCreditRecordsMatch,
    checkDueDetailsMatch,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    genDueDetail,
} from "../../BaseTest";
import {
    getLatestBlock,
    getStartOfNextMonth,
    isCloseTo,
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

describe("ReceivableFactoringCreditManager Test", function () {
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
        await creditManagerContract.connect(poolOperator).addPayer(payer.getAddress());

        await borrowerFirstLossCoverContract.connect(poolOwner).addCoverProvider(borrower.address);
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);

        await juniorTrancheVaultContract.connect(lender).deposit(toToken(10_000_000));
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("addPayer and removePayer", function () {
        it("Should allow the pool operator to add and remove payers", async function () {
            const payerRole = await creditManagerContract.PAYER_ROLE();
            await expect(creditManagerContract.connect(poolOperator).addPayer(payer.getAddress()))
                .to.emit(creditManagerContract, "PayerAdded")
                .withArgs(await payer.getAddress());
            expect(await creditManagerContract.hasRole(payerRole, payer.getAddress())).to.be.true;

            await expect(
                creditManagerContract.connect(poolOperator).removePayer(payer.getAddress()),
            )
                .to.emit(creditManagerContract, "PayerRemoved")
                .withArgs(await payer.getAddress());
            expect(await creditManagerContract.hasRole(payerRole, payer.getAddress())).to.be.false;
        });

        it("Should not allow non-pool operators to add or remove payers", async function () {
            await expect(
                creditManagerContract.addPayer(payer.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolOperatorRequired");
            await expect(
                creditManagerContract.removePayer(payer.getAddress()),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolOperatorRequired");
        });

        it("Should not add or remove payers with 0 addresses", async function () {
            await expect(
                creditManagerContract.connect(poolOperator).addPayer(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(creditManagerContract, "ZeroAddressProvided");
            await expect(
                creditManagerContract
                    .connect(poolOperator)
                    .removePayer(ethers.constants.AddressZero),
            ).to.be.revertedWithCustomError(creditManagerContract, "ZeroAddressProvided");
        });
    });

    describe("approveReceivable", function () {
        const yieldInBps = 1217;
        const numOfPeriods = 1;
        let creditLimit: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForApproveReceivable() {
            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            creditLimit = toToken(15_000);
        }

        beforeEach(async function () {
            await loadFixture(prepareForApproveReceivable);
        });

        it("Should not approve when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit,
                        receivableId: tokenId,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit,
                        receivableId: tokenId,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
        });

        it("Should not allow non-EA service account to approve", async function () {
            await expect(
                creditManagerContract.approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit,
                        receivableId: tokenId,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "EvaluationAgentServiceAccountRequired",
            );
        });

        it("Should not approve if the credit limit exceeds the receivable amount", async function () {
            await expect(
                creditManagerContract.connect(eaServiceAccount).approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit.sub(toToken(1)),
                        receivableId: tokenId,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            ).to.be.revertedWithCustomError(creditManagerContract, "InsufficientReceivableAmount");
        });

        it("Should not approve if the receivable ID is 0", async function () {
            await expect(
                creditManagerContract.connect(eaServiceAccount).approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit,
                        receivableId: 0,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            ).to.be.revertedWithCustomError(creditManagerContract, "ZeroReceivableIdProvided");
        });

        it("Should approve a borrower correctly", async function () {
            const poolSettings = await poolConfigContract.getPoolSettings();

            await expect(
                creditManagerContract.connect(eaServiceAccount).approveReceivable(
                    borrower.address,
                    {
                        receivableAmount: creditLimit,
                        receivableId: tokenId,
                    },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                ),
            )
                .to.emit(creditManagerContract, "ReceivableFactoringCreditApproved")
                .withArgs(
                    await borrower.getAddress(),
                    creditHash,
                    tokenId,
                    creditLimit,
                    creditLimit,
                    poolSettings.payPeriodDuration,
                    numOfPeriods,
                    yieldInBps,
                );

            const actualCC = await creditManagerContract.getCreditConfig(creditHash);
            const expectedCC = {
                creditLimit,
                committedAmount: 0,
                periodDuration: poolSettings.payPeriodDuration,
                numOfPeriods,
                revolving: false,
                yieldInBps,
                advanceRateInBps: poolSettings.advanceRateInBps,
                receivableAutoApproval: false,
            };
            checkCreditConfigsMatch(actualCC, expectedCC);

            const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const expectedCR = {
                unbilledPrincipal: BN.from(0),
                nextDueDate: 0,
                nextDue: BN.from(0),
                yieldDue: BN.from(0),
                totalPastDue: BN.from(0),
                missedPeriods: 0,
                remainingPeriods: numOfPeriods,
                state: CreditState.Approved,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            expect(await creditManagerContract.getCreditBorrower(creditHash)).to.equal(
                borrower.address,
            );
        });
    });

    describe("refreshCredit", function () {
        const yieldInBps = 1217;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForRefreshCredit() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 0,
                lateFeeBps: 0,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);
        }

        beforeEach(async function () {
            await loadFixture(prepareForRefreshCredit);
        });

        it("Should update the bill correctly", async function () {
            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const settings = await poolConfigContract.getPoolSettings();
            const latePaymentDeadline =
                oldCR.nextDueDate.toNumber() +
                settings.latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;
            const refreshDate = latePaymentDeadline + 100;
            await setNextBlockTimestamp(refreshDate);

            const nextDueDate = await calendarContract.getStartDateOfNextPeriod(
                PayPeriodDuration.Monthly,
                refreshDate,
            );
            const [accruedYieldDue] = calcYieldDue(cc, borrowAmount, CONSTANTS.DAYS_IN_A_MONTH);
            const tomorrow = await calendarContract.getStartOfNextDay(refreshDate);
            const totalPastDue = oldCR.nextDue;

            await expect(creditManagerContract.refreshCredit(tokenId))
                .to.emit(creditContract, "BillRefreshed")
                .withArgs(creditHash, nextDueDate, accruedYieldDue);

            const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const expectedCR = {
                unbilledPrincipal: 0,
                nextDueDate,
                nextDue: accruedYieldDue,
                yieldDue: accruedYieldDue,
                totalPastDue,
                missedPeriods: 1,
                remainingPeriods: numOfPeriods - 1,
                state: CreditState.Delayed,
            };
            checkCreditRecordsMatch(actualCR, expectedCR);

            const actualDD = await creditContract.getDueDetail(creditHash);
            checkDueDetailsMatch(
                actualDD,
                genDueDetail({
                    lateFeeUpdatedDate: tomorrow,
                    yieldPastDue: oldCR.yieldDue,
                    principalPastDue: borrowAmount,
                    accrued: accruedYieldDue,
                }),
            );
        });

        it("Should not allow the bill to be refreshed if the protocol is paused or the pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).refreshCredit(tokenId),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).refreshCredit(tokenId),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
        });
    });

    describe("triggerDefault", function () {
        const yieldInBps = 1217,
            lateFeeBps = 2400;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5,
            defaultGracePeriodInDays = 10;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForTriggerDefault() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays,
                    defaultGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 0,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
        }

        beforeEach(async function () {
            await loadFixture(prepareForTriggerDefault);
        });

        async function testTriggerDefault(drawdownDate: number) {
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);

            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const triggerDefaultDate =
                oldCR.nextDueDate.toNumber() +
                defaultGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(triggerDefaultDate);

            const expectedPrincipalLoss = borrowAmount;
            const startOfDefaultPeriod = await calendarContract.getStartDateOfPeriod(
                cc.periodDuration,
                triggerDefaultDate,
            );
            const daysPassed = await calendarContract.getDaysDiff(
                oldCR.nextDueDate,
                startOfDefaultPeriod,
            );
            const expectedAdditionalYieldPastDue = calcYield(
                borrowAmount,
                yieldInBps,
                daysPassed.toNumber(),
            );
            const expectedYieldDue = calcYield(
                borrowAmount,
                yieldInBps,
                CONSTANTS.DAYS_IN_A_MONTH,
            );
            const expectedYieldLoss = expectedYieldDue
                .add(oldCR.yieldDue)
                .add(expectedAdditionalYieldPastDue);
            // Late fee starts to accrue since the beginning of the second billing cycle until the start of tomorrow.
            const lateFeeDays =
                (
                    await calendarContract.getDaysDiff(oldCR.nextDueDate, triggerDefaultDate)
                ).toNumber() + 1;
            const expectedFeesLoss = await calcYield(borrowAmount, lateFeeBps, lateFeeDays);

            await expect(creditManagerContract.connect(eaServiceAccount).triggerDefault(tokenId))
                .to.emit(creditManagerContract, "DefaultTriggered")
                .withArgs(
                    creditHash,
                    expectedPrincipalLoss,
                    expectedYieldLoss,
                    expectedFeesLoss,
                    await eaServiceAccount.getAddress(),
                )
                .to.emit(creditContract, "BillRefreshed")
                .to.emit(poolContract, "ProfitDistributed")
                .to.emit(poolContract, "LossDistributed");

            const cr = await creditContract["getCreditRecord(uint256)"](tokenId);
            expect(cr.state).to.equal(CreditState.Defaulted);

            // Any further attempt to trigger default is disallowed.
            await expect(
                creditManagerContract.connect(eaServiceAccount).triggerDefault(tokenId),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "DefaultHasAlreadyBeenTriggered",
            );
        }

        it("Should allow default to be triggered once", async function () {
            const currentTS = (await getLatestBlock()).timestamp;
            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const drawdownDate = await calendarContract.getStartDateOfNextPeriod(
                cc.periodDuration,
                currentTS,
            );
            await testTriggerDefault(drawdownDate.toNumber());
        });

        it("Should not allow default to be triggered when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).triggerDefault(tokenId),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).triggerDefault(tokenId),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
        });

        it("Should not allow non-EA service accounts to trigger default", async function () {
            await expect(
                creditManagerContract.triggerDefault(tokenId),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "EvaluationAgentServiceAccountRequired",
            );
        });
    });

    describe("closeCredit", function () {
        let tokenId: BN;

        async function prepareForCloseCredit() {
            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);
        }

        beforeEach(async function () {
            await loadFixture(prepareForCloseCredit);
        });

        describe("When the credit is not approved yet", function () {
            it("Should not allow non-borrower or non-EA to close the credit", async function () {
                await expect(
                    creditManagerContract
                        .connect(lender)
                        .closeCredit(borrower.getAddress(), tokenId),
                ).to.be.revertedWithCustomError(creditManagerContract, "BorrowerOrEARequired");
            });

            it("Should not allow closure when the protocol is paused or pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditManagerContract
                        .connect(borrower)
                        .closeCredit(borrower.getAddress(), tokenId),
                ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditManagerContract
                        .connect(borrower)
                        .closeCredit(borrower.getAddress(), tokenId),
                ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });
        });

        describe("When the credit has been approved", function () {
            const numOfPeriods = 1,
                yieldInBps = 1517;
            let creditLimit: BN;
            let creditHash: string;

            async function approveCredit() {
                creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
                creditLimit = toToken(15_000);

                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveReceivable(
                        borrower.address,
                        { receivableAmount: creditLimit, receivableId: tokenId },
                        creditLimit,
                        numOfPeriods,
                        yieldInBps,
                    );
            }

            beforeEach(async function () {
                await loadFixture(approveCredit);
            });

            it("Should allow the borrower to close a newly approved credit", async function () {
                await expect(
                    creditManagerContract
                        .connect(borrower)
                        .closeCredit(borrower.getAddress(), tokenId),
                )
                    .to.emit(creditManagerContract, "CreditClosed")
                    .withArgs(
                        creditHash,
                        CreditClosureReason.AdminClosure,
                        await borrower.getAddress(),
                    );

                // Make sure relevant fields have been reset.
                const cr = await creditContract["getCreditRecord(uint256)"](tokenId);
                expect(cr.state).to.equal(CreditState.Deleted);
                expect(cr.remainingPeriods).to.equal(ethers.constants.Zero);
                const cc = await creditManagerContract.getCreditConfig(creditHash);
                expect(cc.creditLimit).to.equal(ethers.constants.Zero);
            });
        });
    });

    describe("updateYield", function () {
        const yieldInBps = 1217,
            newYieldInBps = 1517;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let drawdownDate: number;
        let creditHash: string;

        async function prepareForUpdateYield() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 0,
                lateFeeBps: 0,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
            drawdownDate = await getStartOfNextMonth();
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);
        }

        beforeEach(async function () {
            await loadFixture(prepareForUpdateYield);
        });

        async function testUpdate(
            oldYieldDue: BN,
            newYieldDue: BN,
            expectedNextDue: BN,
            expectedYieldDue: BN,
        ) {
            const updateDate: number = drawdownDate + CONSTANTS.SECONDS_IN_A_DAY;
            await setNextBlockTimestamp(updateDate);
            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const oldDD = await creditContract.getDueDetail(creditHash);
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(tokenId, newYieldInBps),
            )
                .to.emit(creditManagerContract, "YieldUpdated")
                .withArgs(
                    creditHash,
                    yieldInBps,
                    newYieldInBps,
                    oldYieldDue,
                    (actualNewYieldDue: BN) =>
                        isCloseTo(actualNewYieldDue, newYieldDue, BN.from(1)),
                    await eaServiceAccount.getAddress(),
                );

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            expect(cc.yieldInBps).to.equal(newYieldInBps);
            const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const expectedCR = {
                ...oldCR,
                ...{
                    nextDue: expectedNextDue,
                    yieldDue: expectedYieldDue,
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR, BN.from(1));
            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
            );
            const expectedDD = {
                ...oldDD,
                ...{
                    accrued: expectedAccruedYield,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD, BN.from(1));
        }

        it("Should update the yield due", async function () {
            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const oldDD = await creditContract.getDueDetail(creditHash);
            const expectedAccruedYield = calcYield(borrowAmount, yieldInBps, 2).add(
                calcYield(borrowAmount, newYieldInBps, CONSTANTS.DAYS_IN_A_MONTH - 2),
            );
            await testUpdate(
                oldDD.accrued,
                expectedAccruedYield,
                oldCR.nextDue.sub(oldCR.yieldDue).add(expectedAccruedYield),
                expectedAccruedYield,
            );
        });

        it("Should not allow update when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(await borrower.getAddress(), 1517),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .updateYield(tokenId, newYieldInBps),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to perform the update", async function () {
            await expect(
                creditManagerContract.updateYield(tokenId, newYieldInBps),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "EvaluationAgentServiceAccountRequired",
            );
        });
    });

    describe("extendRemainingPeriod", function () {
        const yieldInBps = 1217;
        const numOfPeriods = 1;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForExtension() {
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 0,
                lateFeeBps: 0,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );
            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);
        }

        beforeEach(async function () {
            await loadFixture(prepareForExtension);
        });

        it("Should allow the EA to extend the remaining periods of a credit line", async function () {
            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const newRemainingPeriods = oldCR.remainingPeriods + numOfPeriods;
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(tokenId, numOfPeriods),
            )
                .to.emit(creditManagerContract, "RemainingPeriodsExtended")
                .withArgs(
                    creditHash,
                    oldCR.remainingPeriods,
                    newRemainingPeriods,
                    await eaServiceAccount.getAddress(),
                );
            const newCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            expect(newCR.remainingPeriods).to.equal(newRemainingPeriods);
        });

        it("Should not allow extension when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(tokenId, numOfPeriods),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .extendRemainingPeriod(tokenId, numOfPeriods),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to extend the remaining period", async function () {
            await expect(
                creditManagerContract
                    .connect(borrower)
                    .extendRemainingPeriod(tokenId, numOfPeriods),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "EvaluationAgentServiceAccountRequired",
            );
        });
    });

    describe("waiveLateFee", function () {
        const yieldInBps = 1217,
            lateFeeBps = 2400;
        const numOfPeriods = 1,
            latePaymentGracePeriodInDays = 5;
        let creditLimit: BN, borrowAmount: BN, tokenId: BN;
        let creditHash: string;

        async function prepareForUpdateYield() {
            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    latePaymentGracePeriodInDays: latePaymentGracePeriodInDays,
                },
            });
            await poolConfigContract.connect(poolOwner).setFeeStructure({
                yieldInBps,
                minPrincipalRateInBps: 0,
                lateFeeBps,
            });

            await nftContract.mintNFT(borrower.address, "");
            tokenId = await nftContract.tokenOfOwnerByIndex(borrower.address, 0);
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            creditHash = await receivableLevelCreditHash(creditContract, nftContract, tokenId);
            borrowAmount = toToken(15_000);
            creditLimit = borrowAmount.mul(5);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(
                    borrower.address,
                    { receivableAmount: creditLimit, receivableId: tokenId },
                    creditLimit,
                    numOfPeriods,
                    yieldInBps,
                );

            const drawdownDate = await getStartOfNextMonth();
            await setNextBlockTimestamp(drawdownDate);
            await creditContract.connect(borrower).drawdownWithReceivable(tokenId, borrowAmount);

            const cc = await creditManagerContract.getCreditConfig(creditHash);
            const refreshDate =
                (
                    await calendarContract.getStartDateOfNextPeriod(
                        cc.periodDuration,
                        drawdownDate,
                    )
                ).toNumber() +
                latePaymentGracePeriodInDays * CONSTANTS.SECONDS_IN_A_DAY +
                600;
            await setNextBlockTimestamp(refreshDate);
            await creditManagerContract.refreshCredit(tokenId);
        }

        beforeEach(async function () {
            await loadFixture(prepareForUpdateYield);
        });

        async function testWaiveLateFee(waivedAmount: BN, expectedNewLateFee: BN) {
            const oldCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            expect(oldCR.totalPastDue).to.be.gt(0);
            const oldDD = await creditContract.getDueDetail(creditHash);
            expect(oldDD.lateFee).to.be.gt(0);
            await expect(
                creditManagerContract
                    .connect(eaServiceAccount)
                    .waiveLateFee(tokenId, waivedAmount),
            )
                .to.emit(creditManagerContract, "LateFeeWaived")
                .withArgs(
                    creditHash,
                    oldDD.lateFee,
                    expectedNewLateFee,
                    await eaServiceAccount.getAddress(),
                );

            const actualCR = await creditContract["getCreditRecord(uint256)"](tokenId);
            const expectedCR = {
                ...oldCR,
                ...{
                    totalPastDue: oldCR.totalPastDue.sub(oldDD.lateFee).add(expectedNewLateFee),
                },
            };
            checkCreditRecordsMatch(actualCR, expectedCR);
            const actualDD = await creditContract.getDueDetail(creditHash);
            const expectedDD = {
                ...oldDD,
                ...{
                    lateFee: expectedNewLateFee,
                },
            };
            checkDueDetailsMatch(actualDD, expectedDD);
        }

        it("Should allow the EA to fully waive late fees", async function () {
            const oldDD = await creditContract.getDueDetail(creditHash);
            const waivedAmount = oldDD.lateFee.add(toToken(1));
            const expectedNewLateFee = toToken(0);
            await testWaiveLateFee(waivedAmount, expectedNewLateFee);
        });

        it("Should not allow update when the protocol is paused or pool is not on", async function () {
            await humaConfigContract.connect(protocolOwner).pause();
            await expect(
                creditManagerContract.connect(eaServiceAccount).waiveLateFee(tokenId, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "ProtocolIsPaused");
            await humaConfigContract.connect(protocolOwner).unpause();

            await poolContract.connect(poolOwner).disablePool();
            await expect(
                creditManagerContract.connect(eaServiceAccount).waiveLateFee(tokenId, toToken(1)),
            ).to.be.revertedWithCustomError(poolConfigContract, "PoolIsNotOn");
            await poolContract.connect(poolOwner).enablePool();
        });

        it("Should not allow non-EAs to waive the late fee", async function () {
            await expect(
                creditManagerContract.waiveLateFee(tokenId, toToken(1)),
            ).to.be.revertedWithCustomError(
                creditManagerContract,
                "EvaluationAgentServiceAccountRequired",
            );
        });
    });
});
