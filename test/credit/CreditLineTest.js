const {ethers} = require("hardhat");
const {expect} = require("chai");
const {BigNumber: BN} = require("ethers");
const {loadFixture} = require("@nomicfoundation/hardhat-network-helpers");
const {
    deployProtocolContracts,
    deployAndSetupPoolContracts,
    CONSTANTS,
    checkEpochInfo,
} = require("../BaseTest");
const {toToken, mineNextBlockWithTimestamp, setNextBlockTimestamp} = require("../TestUtils");

let defaultDeployer, protocolOwner, treasury, eaServiceAccount, pdsServiceAccount;
let poolOwner, poolOwnerTreasury, evaluationAgent, poolOperator;
let lender, borrower;

let eaNFTContract, humaConfigContract, mockTokenContract;
let poolConfigContract,
    platformFeeManagerContract,
    poolVaultContract,
    calendarContract,
    firstLossCovererContract,
    tranchesPolicyContract,
    poolContract,
    epochManagerContract,
    seniorTrancheVaultContract,
    juniorTrancheVaultContract,
    creditContract,
    creditFeeManagerContract,
    creditPnlManagerContract;

describe("CreditLine Test", function () {
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
            poolOwner
        );

        [
            poolConfigContract,
            platformFeeManagerContract,
            poolVaultContract,
            calendarContract,
            firstLossCovererContract,
            tranchesPolicyContract,
            poolContract,
            epochManagerContract,
            seniorTrancheVaultContract,
            juniorTrancheVaultContract,
            creditContract,
            creditFeeManagerContract,
            creditPnlManagerContract,
        ] = await deployAndSetupPoolContracts(
            humaConfigContract,
            mockTokenContract,
            eaNFTContract,
            "RiskAdjustedTranchesPolicy",
            defaultDeployer,
            poolOwner,
            "CreditLine",
            evaluationAgent,
            poolOwnerTreasury,
            poolOperator,
            [lender, borrower]
        );
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Should approve a borrower correctly", async function () {
        const creditHash = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address"],
                [creditContract.address, borrower.address]
            )
        );

        await expect(
            creditContract
                .connect(eaServiceAccount)
                .approveBorrower(borrower.address, toToken(10_000), 1, 1217, toToken(10_000), true)
        )
            .to.emit(creditContract, "CreditApproved")
            .withArgs(
                borrower.address,
                creditHash,
                toToken(10_000),
                1,
                1217,
                toToken(10_000),
                true
            );
    });

    it("Should drawdown from a credit correctly", async function () {
        let juniorDepositAmount = toToken(300_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(100_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);

        await creditContract
            .connect(eaServiceAccount)
            .approveBorrower(borrower.address, toToken(100_000), 1, 1217, toToken(100_000), true);

        await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));
    });

    it("Should makePayment to a credit correctly", async function () {
        const creditHash = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "address"],
                [creditContract.address, borrower.address]
            )
        );

        let juniorDepositAmount = toToken(300_000);
        await juniorTrancheVaultContract
            .connect(lender)
            .deposit(juniorDepositAmount, lender.address);
        let seniorDepositAmount = toToken(100_000);
        await seniorTrancheVaultContract
            .connect(lender)
            .deposit(seniorDepositAmount, lender.address);

        await creditContract
            .connect(eaServiceAccount)
            .approveBorrower(borrower.address, toToken(100_000), 1, 1217, toToken(100_000), true);

        await creditContract.connect(borrower).drawdown(borrower.address, toToken(10_000));

        await creditContract.connect(borrower).makePayment(borrower.address, toToken(100));
    });
});
