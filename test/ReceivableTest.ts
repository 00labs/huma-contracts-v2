import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
    Calendar,
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
    Receivable,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { deployProtocolContracts, deployAndSetupPoolContracts, ReceivableState } from "./BaseTest";

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
    affiliateFirstLossCoverProfitEscrowContract: ProfitEscrow,
    tranchesPolicyContract: RiskAdjustedTranchesPolicy,
    poolContract: Pool,
    epochManagerContract: EpochManager,
    seniorTrancheVaultContract: TrancheVault,
    juniorTrancheVaultContract: TrancheVault,
    creditContract: MockPoolCredit,
    receivableContract: Receivable;

describe("Receivable Test", function () {
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
            affiliateFirstLossCoverProfitEscrowContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract as unknown,
            ,
            receivableContract,
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

        await receivableContract
            .connect(poolOwner)
            .grantRole(receivableContract.MINTER_ROLE(), borrower.address);

        await receivableContract.connect(borrower).createReceivable(
            0, // currencyCode
            1000,
            100,
            "Test URI",
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("createReceivable", function () {
        it("Should only allow the minter role to create receivable", async function () {
            await expect(
                receivableContract.connect(eaServiceAccount).createReceivable(
                    0, // currencyCode
                    100,
                    100,
                    "Test URI",
                ),
            ).to.be.revertedWith(
                `AccessControl: account ${eaServiceAccount.address.toLowerCase()} is missing role ${await receivableContract.MINTER_ROLE()}`,
            );
        });

        it("Should emit a ReceivableCreated event when creating a receivable", async function () {
            await expect(
                receivableContract.connect(borrower).createReceivable(
                    0, // currencyCode
                    1000,
                    100,
                    "Test URI",
                ),
            ).to.emit(receivableContract, "ReceivableCreated");
        });

        it("Stores the correct details on chain when creating a receivable", async function () {
            await receivableContract.connect(borrower).createReceivable(
                0, // currencyCode
                1000,
                100,
                "Test URI",
            );
            await receivableContract.connect(borrower).createReceivable(
                5, // currencyCode
                1000,
                100,
                "Test URI",
            );

            expect(await receivableContract.balanceOf(borrower.address)).to.equal(3);

            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 1);

            const tokenDetails = await receivableContract.receivableInfoMap(tokenId);
            expect(tokenDetails.currencyCode).to.equal(0);
            expect(tokenDetails.receivableAmount).to.equal(1000);
            expect(tokenDetails.maturityDate).to.equal(100);
            expect(tokenDetails.paidAmount).to.equal(0);

            const tokenURI = await receivableContract.tokenURI(tokenId);
            expect(tokenURI).to.equal("Test URI");

            const tokenId2 = await receivableContract.tokenOfOwnerByIndex(borrower.address, 2);

            const tokenDetails2 = await receivableContract.receivableInfoMap(tokenId2);
            expect(tokenDetails2.currencyCode).to.equal(5);
            expect(tokenDetails2.receivableAmount).to.equal(1000);
            expect(tokenDetails2.maturityDate).to.equal(100);
            expect(tokenDetails2.paidAmount).to.equal(0);

            const tokenURI2 = await receivableContract.tokenURI(tokenId2);
            expect(tokenURI).to.equal("Test URI");
        });
    });

    describe("declarePayment", function () {
        it("Should emit a PaymentDeclared event and update on chain storage when declaring a payment", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await expect(
                receivableContract.connect(borrower).declarePayment(tokenId, 100),
            ).to.emit(receivableContract, "PaymentDeclared");

            const tokenDetails = await receivableContract.receivableInfoMap(tokenId);
            expect(tokenDetails.paidAmount).to.equal(100);
        });

        it("Should revert declare payment when not called by token owner", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);

            await expect(
                receivableContract.connect(poolOwner).declarePayment(tokenId, 1000),
            ).to.be.revertedWithCustomError(receivableContract, "notNFTOwner");
        });
    });

    describe("getStatus", function () {
        it("Should return the correct status if a receivable is unpaid", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            const status = await receivableContract.getStatus(tokenId);
            expect(status).to.equal(ReceivableState.Minted);
        });

        it("Should return the correct status if a receivable is partially paid", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract.connect(borrower).declarePayment(tokenId, 100);

            const status = await receivableContract.getStatus(tokenId);
            expect(status).to.equal(ReceivableState.PartiallyPaid);
        });

        it("Should return the correct status if a receivable is fully paid", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract.connect(borrower).declarePayment(tokenId, 1000);

            const status = await receivableContract.getStatus(tokenId);
            expect(status).to.equal(ReceivableState.Paid);
        });
    });
});
