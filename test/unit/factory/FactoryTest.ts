import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
    Calendar,
    CreditDueManager,
    CreditLine,
    CreditLineManager,
    EpochManager,
    FirstLossCover,
    FixedSeniorYieldTranchesPolicy,
    HumaConfig,
    MockToken,
    Pool,
    PoolConfig,
    PoolFactory,
    PoolFeeManager,
    PoolSafe,
    Receivable,
    ReceivableBackedCreditLine,
    ReceivableBackedCreditLineManager,
    ReceivableFactoringCredit,
    ReceivableFactoringCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../../../typechain-types";
import {
    deployFactory,
    deployImplementationContracts,
    deployPoolWithFactory,
    deployProtocolContracts,
    deployReceivableWithFactory,
} from "../../BaseTest";
import { toToken } from "../../TestUtils";

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    lender: SignerWithAddress;

let humaConfigContract: HumaConfig, mockTokenContract: MockToken;
let poolConfigImpl: PoolConfig,
    poolFeeManagerImpl: PoolFeeManager,
    poolSafeImpl: PoolSafe,
    calendarContract: Calendar,
    firstLossCoverImpl: FirstLossCover,
    riskAdjustedTranchesPolicyImpl: RiskAdjustedTranchesPolicy,
    fixedSeniorYieldTranchesPolicyImpl: FixedSeniorYieldTranchesPolicy,
    poolImpl: Pool,
    epochManagerImpl: EpochManager,
    TrancheVaultImpl: TrancheVault,
    creditLineImpl: CreditLine,
    creditDueManagerImpl: CreditDueManager,
    borrowerLevelCreditManagerImpl: CreditLineManager,
    receivableBackedCreditLineImpl: ReceivableBackedCreditLine,
    receivableBackedCreditLineManagerImpl: ReceivableBackedCreditLineManager,
    receivableFactoringCreditImpl: ReceivableFactoringCredit,
    receivableLevelCreditManagerImpl: ReceivableFactoringCreditManager,
    receivableImpl: Receivable;

let poolFactoryContract: PoolFactory;

let receivableContract: Receivable;

describe("Factory Test", function () {
    before(async function () {
        [
            defaultDeployer,
            protocolOwner,
            treasury,
            pdsServiceAccount,
            poolOwner,
            poolOwnerTreasury,
            evaluationAgent,
            poolOperator,
            lender,
        ] = await ethers.getSigners();
    });

    async function prepare() {
        [humaConfigContract, mockTokenContract] = await deployProtocolContracts(
            protocolOwner,
            treasury,
            pdsServiceAccount,
            poolOwner,
        );

        // deploy implementation contracts
        [
            poolConfigImpl,
            poolFeeManagerImpl,
            poolSafeImpl,
            firstLossCoverImpl,
            riskAdjustedTranchesPolicyImpl,
            fixedSeniorYieldTranchesPolicyImpl,
            poolImpl,
            epochManagerImpl,
            TrancheVaultImpl,
            creditLineImpl,
            receivableBackedCreditLineImpl,
            receivableFactoringCreditImpl,
            creditDueManagerImpl,
            borrowerLevelCreditManagerImpl,
            receivableBackedCreditLineManagerImpl,
            receivableLevelCreditManagerImpl,
            receivableImpl,
        ] = await deployImplementationContracts();

        const Calendar = await ethers.getContractFactory("Calendar");
        const calendarContract = (await Calendar.deploy()) as Calendar;
        await calendarContract.deployed();

        // deploy pool factory
        poolFactoryContract = await deployFactory(
            defaultDeployer,
            humaConfigContract,
            calendarContract,
            poolConfigImpl,
            poolFeeManagerImpl,
            poolSafeImpl,
            firstLossCoverImpl,
            riskAdjustedTranchesPolicyImpl,
            fixedSeniorYieldTranchesPolicyImpl,
            poolImpl,
            epochManagerImpl,
            TrancheVaultImpl,
            creditLineImpl,
            receivableBackedCreditLineImpl,
            receivableFactoringCreditImpl,
            creditDueManagerImpl,
            borrowerLevelCreditManagerImpl,
            receivableBackedCreditLineManagerImpl,
            receivableLevelCreditManagerImpl,
            receivableImpl,
        );

        receivableContract = await deployReceivableWithFactory(poolFactoryContract, poolOwner);
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    it("Cannot set zero address to receivable implementation", async function () {
        await expect(
            poolFactoryContract.setReceivableImplAddress(ethers.constants.AddressZero),
        ).to.be.revertedWithCustomError(poolFactoryContract, "ZeroAddressProvided");
    });

    it("Deployer role test", async function () {
        await poolFactoryContract.addDeployer(poolOperator.getAddress());
        expect(
            await poolFactoryContract.hasRole(
                poolFactoryContract.DEPLOYER_ROLE(),
                poolOperator.getAddress(),
            ),
        ).to.be.true;
        await poolFactoryContract.removeDeployer(poolOperator.getAddress());
        expect(
            await poolFactoryContract.hasRole(
                poolFactoryContract.DEPLOYER_ROLE(),
                poolOperator.getAddress(),
            ),
        ).to.be.false;
    });

    it("Non Factory Admin cannot add or remove deployer", async function () {
        await expect(
            poolFactoryContract.connect(poolOperator).addDeployer(poolOperator.getAddress()),
        ).to.be.revertedWithCustomError(poolFactoryContract, "HumaOwnerRequired");
        await expect(
            poolFactoryContract.connect(poolOperator).removeDeployer(defaultDeployer.getAddress()),
        ).to.be.revertedWithCustomError(poolFactoryContract, "HumaOwnerRequired");
    });

    it("Deploy a pool using factory", async function () {
        const poolRecord = await deployPoolWithFactory(
            poolFactoryContract,
            mockTokenContract,
            await ethers.getContractAt("Receivable", ethers.constants.AddressZero),
            "creditline",
            "fixed",
            "test pool",
        );
        expect(poolRecord.poolName).to.equal("test pool");
        expect(poolRecord.poolStatus).to.equal(0);
    });

    it("Deploy a pool using factory - non deployer", async function () {
        await expect(
            poolFactoryContract
                .connect(poolOwner)
                .deployPool(
                    "test pool",
                    mockTokenContract.address,
                    receivableContract.address,
                    "fixed",
                    "creditline",
                ),
        ).to.be.revertedWithCustomError(poolFactoryContract, "DeployerRequired");
    });

    it("Deploy a pool using factory - invalid pool type", async function () {
        await expect(
            poolFactoryContract.deployPool(
                "test pool",
                mockTokenContract.address,
                receivableContract.address,
                "invalid",
                "",
            ),
        ).to.be.revertedWithCustomError(poolFactoryContract, "InvalidTranchesPolicyType");
    });

    it("Deploy a pool using factory - invalid credit line type", async function () {
        await expect(
            poolFactoryContract.deployPool(
                "test pool",
                mockTokenContract.address,
                receivableContract.address,
                "fixed",
                "",
            ),
        ).to.be.revertedWithCustomError(poolFactoryContract, "InvalidCreditType");
    });

    it("Deploy a pool using factory and initialize the pool", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "fixed",
            "creditline",
        );
        await poolFactoryContract.setPoolSettings(
            1,
            toToken(1_000_000),
            toToken(50_000),
            1,
            30,
            30,
            10000,
            true,
            true,
        );
        await poolFactoryContract.setLPConfig(1, toToken(1_000_000), 4, 1000, 1000, 60, false);
        await poolFactoryContract.setFees(1, 0, 1000, 1500, 0, 100, 0, 0, 0, 0);
        await poolFactoryContract.addPoolOperator(1, poolOperator.getAddress());
        await poolFactoryContract.updatePoolStatus(1, 1);
        expect((await poolFactoryContract.checkPool(1)).poolStatus).to.equal(1);
    });

    it("Deploy a pool using factory and initialize the pool, then add timelock", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "fixed",
            "creditline",
        );
        await poolFactoryContract.setPoolSettings(
            1,
            toToken(1_000_000),
            toToken(50_000),
            1,
            30,
            30,
            10000,
            true,
            true,
        );
        await poolFactoryContract.setLPConfig(1, toToken(1_000_000), 4, 1000, 1000, 60, false);
        await poolFactoryContract.setFees(1, 0, 1000, 1500, 0, 100, 0, 0, 0, 0);
        await poolFactoryContract.setPoolOwnerTreasury(1, poolOwnerTreasury.getAddress());
        await poolFactoryContract.setPoolEvaluationAgent(1, evaluationAgent.getAddress());
        await poolFactoryContract.addPoolOperator(1, poolOperator.getAddress());
        await poolFactoryContract.updatePoolStatus(1, 1);
        expect((await poolFactoryContract.checkPool(1)).poolStatus).to.equal(1);
        await poolFactoryContract.addTimelock(
            1,
            [poolOwner.getAddress()],
            [poolOwner.getAddress()],
        );
        const poolConfigAddress = (await poolFactoryContract.checkPool(1)).poolConfigAddress;
        const timelockAddress = (await poolFactoryContract.checkPool(1)).poolTimelock;
        const poolConfig = await ethers.getContractAt("PoolConfig", poolConfigAddress);
        expect(
            await poolConfig.hasRole(
                await poolConfig.DEFAULT_ADMIN_ROLE(),
                poolOwner.getAddress(),
            ),
        ).to.be.false;
        expect(await poolConfig.hasRole(await poolConfig.DEFAULT_ADMIN_ROLE(), timelockAddress)).to
            .be.true;
    });

    it("Set first loss cover", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "fixed",
            "creditline",
        );
        const poolId = await poolFactoryContract.poolId();
        await poolFactoryContract.setPoolSettings(
            poolId,
            toToken(1_000_000),
            toToken(50_000),
            1,
            30,
            30,
            10000,
            true,
            true,
        );
        await poolFactoryContract.setLPConfig(
            poolId,
            toToken(1_000_000),
            4,
            1000,
            1000,
            60,
            false,
        );
        await poolFactoryContract.setFees(poolId, 0, 1000, 1500, 0, 100, 0, 0, 0, 0);
        await poolFactoryContract.addPoolOperator(poolId, poolOperator.getAddress());
        await poolFactoryContract.updatePoolStatus(poolId, 1);

        expect((await poolFactoryContract.checkPool(poolId)).poolStatus).to.equal(1);
        const poolConfigAddress = (await poolFactoryContract.checkPool(poolId)).poolConfigAddress;
        await poolFactoryContract.setFirstLossCover(
            poolConfigAddress,
            1,
            10000,
            toToken(5000),
            toToken(10000),
            toToken(5000),
            15000,
            "Borrower First Loss Cover",
            "BFLC",
        );
    });

    it("Non deployer cannot set first loss cover", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "adjusted",
            "receivablebacked",
        );
        await expect(
            poolFactoryContract
                .connect(poolOperator)
                .setFirstLossCover(
                    poolFactoryContract.address,
                    1,
                    10000,
                    toToken(5000),
                    toToken(10000),
                    toToken(5000),
                    15000,
                    "Borrower First Loss Cover",
                    "BFLC",
                ),
        ).to.be.revertedWithCustomError(poolFactoryContract, "DeployerRequired");
    });

    it("Close a pool", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "adjusted",
            "receivablefactoring",
        );
        const poolId = await poolFactoryContract.poolId();
        await poolFactoryContract.updatePoolStatus(poolId, 2);
        expect((await poolFactoryContract.checkPool(poolId)).poolStatus).to.equal(2);
    });

    it("Check invalid poolId", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "adjusted",
            "receivablefactoring",
        );
        const poolId = await poolFactoryContract.poolId();
        await expect(poolFactoryContract.checkPool(poolId.add(1))).to.be.revertedWithCustomError(
            poolFactoryContract,
            "InvalidPoolId",
        );
        await expect(poolFactoryContract.checkPool(0)).to.be.revertedWithCustomError(
            poolFactoryContract,
            "InvalidPoolId",
        );
    });

    it("Update a poolStatus - invalid poolId", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "adjusted",
            "receivablefactoring",
        );
        const poolId = await poolFactoryContract.poolId();
        await expect(
            poolFactoryContract.updatePoolStatus(poolId.add(1), 1),
        ).to.be.revertedWithCustomError(poolFactoryContract, "InvalidPoolId");
        await expect(poolFactoryContract.updatePoolStatus(0, 1)).to.be.revertedWithCustomError(
            poolFactoryContract,
            "InvalidPoolId",
        );
    });

    it("Update a poolStatus - non deployer", async function () {
        await poolFactoryContract.deployPool(
            "test pool",
            mockTokenContract.address,
            receivableContract.address,
            "adjusted",
            "receivablefactoring",
        );
        const poolId = await poolFactoryContract.poolId();
        await expect(
            poolFactoryContract.connect(poolOperator).updatePoolStatus(poolId, 1),
        ).to.be.revertedWithCustomError(poolFactoryContract, "DeployerRequired");
    });

    it("PoolFactory cannot be initialized twice", async function () {
        await expect(
            poolFactoryContract.initialize(humaConfigContract.address),
        ).to.be.revertedWith("Initializable: contract is already initialized");
    });
});
