import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
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
    Receivable,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    ReceivableState,
    deployAndSetupPoolContracts,
    deployProtocolContracts,
} from "../../BaseTest";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    sentinelServiceAccount: SignerWithAddress;
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
            sentinelServiceAccount,
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
            sentinelServiceAccount,
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
            ,
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
            "CreditLineManager",
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
            "referenceId",
            "Test URI",
        );

        const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
        expect(tokenId).to.equal(1); // tokenId should start at 1
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    describe("createReceivable and burn", function () {
        it("Should only allow the minter role to create receivable", async function () {
            await expect(
                receivableContract.connect(eaServiceAccount).createReceivable(
                    0, // currencyCode
                    100,
                    100,
                    "referenceId2",
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
                    "referenceId2",
                    "Test URI",
                ),
            ).to.emit(receivableContract, "ReceivableCreated");
        });

        it("Should not allow multiple receivables to be created with the same reference id unless the existing one is burned", async function () {
            await expect(
                receivableContract.connect(borrower).createReceivable(
                    0, // currencyCode
                    1000,
                    100,
                    "referenceId",
                    "Test URI",
                ),
            ).to.be.revertedWithCustomError(
                receivableContract,
                "ReceivableReferenceIdAlreadyExists",
            );

            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract.connect(borrower).burn(tokenId);
            await receivableContract.connect(borrower).createReceivable(
                0, // currencyCode
                1000,
                100,
                "referenceId",
                "Test URI",
            );
        });

        it("Should correctly map reference id to the token id in referenceIdHashToTokenIdMap", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            const receivableIdCreatorHash = await receivableContract.getReferenceIdHash(
                "referenceId",
                borrower.address,
            );
            const lookupTokenId =
                await receivableContract.referenceIdHashToTokenId(receivableIdCreatorHash);

            expect(lookupTokenId).to.equal(tokenId);
        });

        it("Stores the correct details on chain when creating a receivable", async function () {
            await receivableContract.connect(borrower).createReceivable(
                0, // currencyCode
                1000,
                100,
                "referenceId2",
                "Test URI",
            );
            await receivableContract.connect(borrower).createReceivable(
                5, // currencyCode
                1000,
                100,
                "referenceId3",
                "Test URI2",
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
            await receivableContract.connect(borrower).burn(tokenId);
            expect(await receivableContract.balanceOf(borrower.getAddress())).to.equal(2);

            const tokenId2 = await receivableContract.tokenOfOwnerByIndex(borrower.address, 1);
            const tokenDetails2 = await receivableContract.receivableInfoMap(tokenId2);
            expect(tokenDetails2.currencyCode).to.equal(5);
            expect(tokenDetails2.receivableAmount).to.equal(1000);
            expect(tokenDetails2.maturityDate).to.equal(100);
            expect(tokenDetails2.paidAmount).to.equal(0);
            const tokenURI2 = await receivableContract.tokenURI(tokenId2);
            expect(tokenURI2).to.equal("Test URI2");
            await receivableContract.connect(borrower).burn(tokenId2);
            expect(await receivableContract.balanceOf(borrower.getAddress())).to.equal(1);
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
            expect(tokenDetails.state).to.equal(ReceivableState.PartiallyPaid);
        });

        it("Should allow the creator to declare payment", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract
                .connect(borrower)
                ["safeTransferFrom(address,address,uint256)"](
                    borrower.address,
                    lender.address,
                    tokenId,
                );
            await expect(
                receivableContract.connect(borrower).declarePayment(tokenId, 100),
            ).to.emit(receivableContract, "PaymentDeclared");

            const tokenDetails = await receivableContract.receivableInfoMap(tokenId);
            expect(tokenDetails.paidAmount).to.equal(100);
            expect(tokenDetails.state).to.equal(ReceivableState.PartiallyPaid);
        });

        it("Should not allow non-token owner or non-creator to declare payment", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);

            await expect(
                receivableContract.connect(poolOwner).declarePayment(tokenId, 1000),
            ).to.be.revertedWithCustomError(
                receivableContract,
                "ReceivableOwnerOrCreatorRequired",
            );
        });

        it("Should not allow zero payment amount", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);

            await expect(
                receivableContract.connect(poolOwner).declarePayment(tokenId, 0),
            ).to.be.revertedWithCustomError(receivableContract, "ZeroAmountProvided");
        });
    });

    describe("getReceivable", function () {
        it("Should return the receivable", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            const actualReceivable = await receivableContract.getReceivable(tokenId);
            expect(actualReceivable.state).to.equal(ReceivableState.Minted);
            expect(actualReceivable.receivableAmount).to.equal(1000);
            expect(actualReceivable.paidAmount).to.equal(0);
        });
    });

    describe("updateReceivableMetadata", function () {
        it("Should emit a ReceivableMetadataUpdated event when creating a receivable update", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await expect(
                receivableContract.connect(borrower).updateReceivableMetadata(tokenId, "uri2"),
            ).to.emit(receivableContract, "ReceivableMetadataUpdated");
        });

        it("Should not allow for updates to be created for non-existant receivable", async function () {
            await expect(
                receivableContract.connect(borrower).updateReceivableMetadata(123, "uri2"),
            ).to.be.revertedWith("ERC721: invalid token ID");
        });

        it("Should allow the creator to create a receivable update even after the original receivable has been transferred", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);
            await receivableContract
                .connect(borrower)
                ["safeTransferFrom(address,address,uint256)"](
                    borrower.address,
                    lender.address,
                    tokenId,
                );

            await receivableContract.connect(borrower).updateReceivableMetadata(tokenId, "uri2");

            const tokenURI = await receivableContract.tokenURI(tokenId);
            expect(tokenURI).to.equal("uri2");
        });

        it("Should not allow a non-owner and non-creator to create a receivable update", async function () {
            const tokenId = await receivableContract.tokenOfOwnerByIndex(borrower.address, 0);

            await expect(
                receivableContract.connect(poolOwner).updateReceivableMetadata(tokenId, "uri2"),
            ).to.be.revertedWithCustomError(
                receivableContract,
                "ReceivableOwnerOrCreatorRequired",
            );
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

    describe("supportsInterface", function () {
        it("Should support interfaces that the contract implements", async function () {
            for (const interfaceId of ["0x6921aa19", "0x80ac58cd", "0x7965db0b"]) {
                expect(await receivableContract.supportsInterface(interfaceId)).to.be.true;
            }
        });

        it("Should not support interfaces that the contract doesn't implement", async function () {
            expect(await receivableContract.supportsInterface("0x17ab19ef")).to.be.false;
        });
    });
});
