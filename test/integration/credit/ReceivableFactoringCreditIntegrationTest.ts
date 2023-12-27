import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
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
    ReceivableLevelCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    CONSTANTS,
    PayPeriodDuration,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
    printCreditRecord,
} from "../../BaseTest";
import {
    evmRevert,
    evmSnapshot,
    getMinFirstLossCoverRequirement,
    receivableLevelCreditHash,
    setNextBlockTimestamp,
    toToken,
} from "../../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
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
    affiliateFirstLossCoverContract: FirstLossCover,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: ReceivableFactoringCredit,
    creditDueManagerContract: CreditDueManager,
    creditManagerContract: ReceivableLevelCreditManager,
    nftContract: MockNFT;

describe("ReceivableFactoringCredit Integration Tests", function () {
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
            payer,
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
            "ReceivableFactoringCredit",
            "ReceivableLevelCreditManager",
            evaluationAgent,
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

    describe("Bulla case tests", function () {
        let creditHash: string;
        let borrowAmount: BN, paymentAmount: BN;
        let creditLimit: BN;
        const yieldInBps = 1200;
        const lateFeeBps = 2400;
        const principalRate = 0;
        const lateGracePeriodInDays = 5;
        let tokenId: BN;

        async function prepareForBullaTests() {
            borrowAmount = toToken(1_000_000);
            paymentAmount = borrowAmount;
            creditLimit = borrowAmount
                .mul(5)
                .mul(CONSTANTS.BP_FACTOR.add(500))
                .div(CONSTANTS.BP_FACTOR);

            let settings = await poolConfigContract.getPoolSettings();
            await poolConfigContract.connect(poolOwner).setPoolSettings({
                ...settings,
                ...{
                    payPeriodDuration: PayPeriodDuration.Monthly,
                    latePaymentGracePeriodInDays: lateGracePeriodInDays,
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

        let nextTime: number;
        it("approve borrower credit", async function () {
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

        it("payee draws down with receivable", async function () {
            await nftContract.connect(borrower).approve(creditContract.address, tokenId);

            await creditContract
                .connect(borrower)
                .drawdownWithReceivable(borrower.address, tokenId, borrowAmount);
        });

        it("payee pays for half of the amount due", async function () {
            let cr = await creditContract["getCreditRecord(bytes32)"](creditHash);
            printCreditRecord("cr", cr);

            await creditContract
                .connect(borrower)
                .makePaymentWithReceivable(borrower.address, tokenId, cr.nextDue.div(2));
        });

        it("refresh credit after late payment grace period", async function () {
            let cr = await creditContract["getCreditRecord(bytes32)"](creditHash);
            nextTime =
                cr.nextDueDate.toNumber() +
                CONSTANTS.SECONDS_IN_A_DAY * lateGracePeriodInDays +
                100;
            await setNextBlockTimestamp(nextTime);

            await creditManagerContract.refreshCredit(borrower.address);
            cr = await creditContract["getCreditRecord(bytes32)"](creditHash);
            printCreditRecord("cr", cr);
        });

        it("payer pays the receivable", async function () {
            await nftContract.connect(payer).payOwner(tokenId, creditLimit);

            let cr = await creditContract["getCreditRecord(bytes32)"](creditHash);
            printCreditRecord("cr", cr);
        });
    });
});