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
    MockToken,
    Pool,
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../typechain-types";
import { CONSTANTS, deployAndSetupPoolContracts, deployProtocolContracts } from "../BaseTest";
import { borrowerLevelCreditHash, getMinFirstLossCoverRequirement, toToken } from "../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress;
let lender: SignerWithAddress, borrower: SignerWithAddress;

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
    creditContract: ReceivableBackedCreditLine,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableBackedCreditLineManager,
    receivableContract: Receivable;

describe("ReceivableBackedCreditLineManager Tests", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
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
            treasury,
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
            creditManagerContract as unknown,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "ReceivableBackedCreditLine",
            "ReceivableBackedCreditLineManager",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower],
        );

        const Receivable = await ethers.getContractFactory("Receivable");
        receivableContract = await Receivable.deploy();
        await receivableContract.deployed();

        await receivableContract.connect(poolOwner).initialize();
        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), borrower.address);
        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), lender.address);
        await poolConfigContract.connect(poolOwner).setReceivableAsset(receivableContract.address);

        await borrowerFirstLossCoverContract
            .connect(poolOwner)
            .setCoverProvider(borrower.address, {
                poolCapCoverageInBps: 1,
                poolValueCoverageInBps: 100,
            });
        await mockTokenContract
            .connect(borrower)
            .approve(borrowerFirstLossCoverContract.address, ethers.constants.MaxUint256);
        await borrowerFirstLossCoverContract
            .connect(borrower)
            .depositCover(
                (
                    await getMinFirstLossCoverRequirement(
                        borrowerFirstLossCoverContract,
                        poolConfigContract,
                        poolContract,
                        borrower.address,
                    )
                ).mul(2),
            );

        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(toToken(10_000_000), lender.address);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("approveReceivable", function () {
        let receivableAmount: BN;
        const receivableId = 1;

        beforeEach(async function () {
            receivableAmount = toToken(50_000);
        });

        describe("Without credit approval", function () {
            it("Should not approve receivables from the borrower", async function () {
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: receivableId,
                        }),
                ).to.be.revertedWithCustomError(creditManagerContract, "notBorrower");
            });
        });

        describe("With credit approval", function () {
            const advanceRateInBps = 8000;
            let creditHash: string;

            async function approveBorrower() {
                const settings = await poolConfigContract.getPoolSettings();
                await poolConfigContract.connect(poolOwner).setPoolSettings({
                    ...settings,
                    ...{
                        advanceRateInBps: advanceRateInBps,
                    },
                });
                await creditManagerContract
                    .connect(eaServiceAccount)
                    .approveBorrower(
                        borrower.getAddress(),
                        toToken(100_000),
                        6,
                        1517,
                        toToken(0),
                        0,
                        true,
                    );

                creditHash = await borrowerLevelCreditHash(creditContract, borrower);
            }

            beforeEach(async function () {
                await loadFixture(approveBorrower);
            });

            it("Should approve receivables from the borrower", async function () {
                const incrementalCredit = receivableAmount
                    .mul(advanceRateInBps)
                    .div(CONSTANTS.BP_FACTOR);
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: receivableId,
                        }),
                )
                    .to.emit(creditManagerContract, "ReceivableApproved")
                    .withArgs(
                        await borrower.getAddress(),
                        receivableId,
                        receivableAmount,
                        incrementalCredit,
                        incrementalCredit,
                    );
                const actualCL = await creditManagerContract.getCreditLimit(creditHash);
                expect(actualCL.availableCredit).to.equal(incrementalCredit);

                // Second approval should add onto the available credit.
                const newReceivableAmount = toToken(30_000);
                const newReceivableId = 2;
                const newIncrementalCredit = newReceivableAmount
                    .mul(advanceRateInBps)
                    .div(CONSTANTS.BP_FACTOR);
                const expectedAvailableCredit = actualCL.availableCredit.add(newIncrementalCredit);
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: newReceivableAmount,
                            receivableId: newReceivableId,
                        }),
                )
                    .to.emit(creditManagerContract, "ReceivableApproved")
                    .withArgs(
                        await borrower.getAddress(),
                        newReceivableId,
                        newReceivableAmount,
                        newIncrementalCredit,
                        expectedAvailableCredit,
                    );
                const newActualCL = await creditManagerContract.getCreditLimit(creditHash);
                expect(newActualCL.availableCredit).to.equal(expectedAvailableCredit);
            });

            it("Should not approve the receivable if the protocol is paused or the pool is not on", async function () {
                await humaConfigContract.connect(protocolOwner).pause();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: receivableId,
                        }),
                ).to.be.revertedWithCustomError(poolConfigContract, "protocolIsPaused");
                await humaConfigContract.connect(protocolOwner).unpause();

                await poolContract.connect(poolOwner).disablePool();
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: receivableId,
                        }),
                ).to.be.revertedWithCustomError(poolConfigContract, "poolIsNotOn");
                await poolContract.connect(poolOwner).enablePool();
            });

            it("Should not non-EA service account or non-credit contract to approve receivables", async function () {
                await expect(
                    creditManagerContract
                        .connect(borrower)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: receivableId,
                        }),
                ).to.be.revertedWithCustomError(creditManagerContract, "notAuthorizedCaller");
            });

            it("Should not approve a receivable with 0 amount", async function () {
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: 0,
                            receivableId: receivableId,
                        }),
                ).to.be.revertedWithCustomError(creditManagerContract, "zeroAmountProvided");
            });

            it("Should not approve a receivable with 0 ID", async function () {
                await expect(
                    creditManagerContract
                        .connect(eaServiceAccount)
                        .approveReceivable(borrower.getAddress(), {
                            receivableAmount: receivableAmount,
                            receivableId: 0,
                        }),
                ).to.be.revertedWithCustomError(creditManagerContract, "zeroReceivableIdProvided");
            });
        });
    });

    describe("validateReceivable", function () {
        it("Should reject receivables not owned by the borrower", async function () {
            await expect(
                creditManagerContract.validateReceivable(borrower.getAddress(), 1),
            ).to.be.revertedWithCustomError(creditManagerContract, "receivableIdMismatch");
        });
    });

    describe("decreaseCreditLimit", function () {
        let creditHash: string;
        let receivableAmount: BN;

        async function prepareForDecreaseCreditLimit() {
            receivableAmount = toToken(10_000);

            const settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    advanceRateInBps: CONSTANTS.BP_FACTOR,
                },
            });
            await creditManagerContract
                .connect(eaServiceAccount)
                .approveBorrower(
                    borrower.getAddress(),
                    toToken(100_000),
                    6,
                    1517,
                    toToken(0),
                    0,
                    true,
                );

            creditHash = await borrowerLevelCreditHash(creditContract, borrower);

            await creditManagerContract
                .connect(eaServiceAccount)
                .approveReceivable(borrower.getAddress(), {
                    receivableAmount: receivableAmount,
                    receivableId: 1,
                });
            const cl = await creditManagerContract.getCreditLimit(creditHash);
            expect(cl.availableCredit).to.equal(receivableAmount);

            await poolConfigContract.connect(poolOwner).setCredit(defaultDeployer.getAddress());
            await creditManagerContract.connect(poolOwner).updatePoolConfigData();
        }

        beforeEach(async function () {
            await loadFixture(prepareForDecreaseCreditLimit);
        });

        it("Should allow the credit contract to decrease the credit limit", async function () {
            await creditManagerContract.decreaseCreditLimit(creditHash, receivableAmount);
            const cl = await creditManagerContract.getCreditLimit(creditHash);
            expect(cl.availableCredit).to.equal(0);
        });

        it("Should not allow non-Credit contracts to decrease credit limit", async function () {
            await expect(
                creditManagerContract
                    .connect(borrower)
                    .decreaseCreditLimit(creditHash, receivableAmount),
            ).to.be.revertedWithCustomError(creditManagerContract, "notAuthorizedCaller");
        });

        it("Should not decrease the credit limit beyond what's available", async function () {
            await expect(
                creditManagerContract.decreaseCreditLimit(
                    creditHash,
                    receivableAmount.add(toToken(1)),
                ),
            ).to.be.revertedWithCustomError(creditManagerContract, "creditLineExceeded");
        });
    });
});