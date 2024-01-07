import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
    BorrowerLevelCreditManager,
    Calendar,
    CreditDueManager,
    CreditLine,
    EpochManager,
    EvaluationAgentNFT,
    FirstLossCover,
    FixedSeniorYieldTranchePolicy,
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
    ReceivableLevelCreditManager,
    RiskAdjustedTranchesPolicy,
    TrancheVault,
} from "../typechain-types";
type ProtocolContracts = [EvaluationAgentNFT, HumaConfig, MockToken, Calendar];
type PoolContracts = [
    PoolConfig,
    PoolFeeManager,
    PoolSafe,
    FirstLossCover,
    RiskAdjustedTranchesPolicy,
    FixedSeniorYieldTranchePolicy,
    Pool,
    EpochManager,
    TrancheVault,
    CreditLine,
    ReceivableBackedCreditLine,
    ReceivableFactoringCredit,
    CreditDueManager,
    BorrowerLevelCreditManager,
    ReceivableBackedCreditLineManager,
    ReceivableLevelCreditManager,
    Receivable,
];

let defaultDeployer: SignerWithAddress,
    protocolOwner: SignerWithAddress,
    treasury: SignerWithAddress,
    eaServiceAccount: SignerWithAddress,
    pdsServiceAccount: SignerWithAddress;
let poolOwner: SignerWithAddress,
    poolOwnerTreasury: SignerWithAddress,
    evaluationAgent: SignerWithAddress,
    poolOperator: SignerWithAddress,
    lender: SignerWithAddress;

let eaNFTContract: EvaluationAgentNFT,
    humaConfigContract: HumaConfig,
    mockTokenContract: MockToken;
let poolConfigImpl: PoolConfig,
    poolFeeManagerImpl: PoolFeeManager,
    poolSafeImpl: PoolSafe,
    calendarContract: Calendar,
    firstLossCoverImpl: FirstLossCover,
    riskAdjustedTranchesPolicyImpl: RiskAdjustedTranchesPolicy,
    fixedSeniorYieldTranchePolicyImpl: FixedSeniorYieldTranchePolicy,
    poolImpl: Pool,
    epochManagerImpl: EpochManager,
    TrancheVaultImpl: TrancheVault,
    creditLineImpl: CreditLine,
    creditDueManagerImpl: CreditDueManager,
    borrowerLevelCreditManagerImpl: BorrowerLevelCreditManager,
    receivableBackedCreditLineImpl: ReceivableBackedCreditLine,
    receivableBackedCreditLineManagerImpl: ReceivableBackedCreditLineManager,
    receivableFactoringCreditImpl: ReceivableFactoringCredit,
    receivableLevelCreditManagerImpl: ReceivableLevelCreditManager,
    receivableImpl: Receivable;

let poolFactoryContract: PoolFactory;

describe("Factory Test", function () {
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
        ] = await ethers.getSigners();
    });
    async function deployProtocolContracts(
        protocolOwner: SignerWithAddress,
        treasury: SignerWithAddress,
        eaServiceAccount: SignerWithAddress,
        sentinelServiceAccount: SignerWithAddress,
        poolOwner: SignerWithAddress,
    ): Promise<ProtocolContracts> {
        // Deploy EvaluationAgentNFT
        const EvaluationAgentNFT = await ethers.getContractFactory("EvaluationAgentNFT");
        const eaNFTContract = await EvaluationAgentNFT.deploy();
        await eaNFTContract.deployed();

        // Deploy HumaConfig
        const HumaConfig = await ethers.getContractFactory("HumaConfig");
        let humaConfigContract = await HumaConfig.deploy();
        await humaConfigContract.deployed();

        await humaConfigContract.setHumaTreasury(treasury.getAddress());
        await humaConfigContract.setEANFTContractAddress(eaNFTContract.address);
        await humaConfigContract.setEAServiceAccount(eaServiceAccount.getAddress());
        await humaConfigContract.setSentinelServiceAccount(sentinelServiceAccount.getAddress());

        await humaConfigContract.addPauser(protocolOwner.getAddress());
        await humaConfigContract.addPauser(poolOwner.getAddress());

        await humaConfigContract.transferOwnership(protocolOwner.getAddress());
        if (await humaConfigContract.connect(protocolOwner).paused())
            await humaConfigContract.connect(protocolOwner).unpause();

        const MockToken = await ethers.getContractFactory("MockToken");
        const mockTokenContract = await MockToken.deploy();
        await mockTokenContract.deployed();

        await humaConfigContract
            .connect(protocolOwner)
            .setLiquidityAsset(mockTokenContract.address, true);

        // Deploy Calendar
        const Calendar = await ethers.getContractFactory("Calendar");
        const calendarContract = await Calendar.deploy();
        await calendarContract.deployed();

        return [eaNFTContract, humaConfigContract, mockTokenContract, calendarContract];
    }
    async function deployImplementationContracts(): Promise<PoolContracts> {
        // Deploy PoolConfig
        const PoolConfig = await ethers.getContractFactory("PoolConfig");
        const poolConfigContract = await PoolConfig.deploy();
        await poolConfigContract.deployed();

        // Deploy PoolFeeManager
        const PoolFeeManager = await ethers.getContractFactory("PoolFeeManager");
        const poolFeeManagerContract = await PoolFeeManager.deploy();
        await poolFeeManagerContract.deployed();

        // Deploy PoolSafe
        const PoolSafe = await ethers.getContractFactory("PoolSafe");
        const poolSafeContract = await PoolSafe.deploy();
        await poolSafeContract.deployed();

        // Deploy FirstLossCover
        const FirstLossCover = await ethers.getContractFactory("FirstLossCover");
        const firstLossCoverContract = await FirstLossCover.deploy();
        await firstLossCoverContract.deployed();

        // Deploy RiskAdjustedTranchesPolicy
        const RiskAdjustedTranchesPolicy = await ethers.getContractFactory(
            "RiskAdjustedTranchesPolicy",
        );
        const riskAdjustedTranchesPolicyContract = await RiskAdjustedTranchesPolicy.deploy();
        await riskAdjustedTranchesPolicyContract.deployed();

        // Deploy FixedSeniorYieldTranchePolicy
        const FixedSeniorYieldTranchePolicy = await ethers.getContractFactory(
            "FixedSeniorYieldTranchePolicy",
        );
        const fixedSeniorYieldTranchePolicyContract = await FixedSeniorYieldTranchePolicy.deploy();
        await fixedSeniorYieldTranchePolicyContract.deployed();

        // Deploy Pool
        const Pool = await ethers.getContractFactory("Pool");
        const poolContract = await Pool.deploy();
        await poolContract.deployed();

        // Deploy EpochManager
        const EpochManager = await ethers.getContractFactory("EpochManager");
        const epochManagerContract = await EpochManager.deploy();
        await epochManagerContract.deployed();

        // Deploy TrancheVault
        const TrancheVault = await ethers.getContractFactory("TrancheVault");
        const trancheVaultContract = await TrancheVault.deploy();
        await trancheVaultContract.deployed();

        // Deploy CreditLine
        const CreditLine = await ethers.getContractFactory("CreditLine");
        const creditLineContract = await CreditLine.deploy();
        await creditLineContract.deployed();

        // Deploy CreditDueManager
        const CreditDueManager = await ethers.getContractFactory("CreditDueManager");
        const creditDueManagerContract = await CreditDueManager.deploy();
        await creditDueManagerContract.deployed();

        // Deploy BorrowerLevelCreditManager
        const BorrowerLevelCreditManager = await ethers.getContractFactory(
            "BorrowerLevelCreditManager",
        );
        const borrowerLevelCreditManagerContract = await BorrowerLevelCreditManager.deploy();
        await borrowerLevelCreditManagerContract.deployed();

        // Deploy ReceivableBackedCreditLine
        const ReceivableBackedCreditLine = await ethers.getContractFactory(
            "ReceivableBackedCreditLine",
        );
        const receivableBackedCreditLineContract = await ReceivableBackedCreditLine.deploy();
        await receivableBackedCreditLineContract.deployed();

        // Deploy ReceivableBackedCreditLineManager
        const ReceivableBackedCreditLineManager = await ethers.getContractFactory(
            "ReceivableBackedCreditLineManager",
        );
        const receivableBackedCreditLineManagerContract =
            await ReceivableBackedCreditLineManager.deploy();
        await receivableBackedCreditLineManagerContract.deployed();

        // Deploy ReceivableFactoringCredit
        const ReceivableFactoringCredit = await ethers.getContractFactory(
            "ReceivableFactoringCredit",
        );
        const receivableFactoringCreditContract = await ReceivableFactoringCredit.deploy();
        await receivableFactoringCreditContract.deployed();

        // Deploy ReceivableLevelCreditManager
        const ReceivableLevelCreditManager = await ethers.getContractFactory(
            "ReceivableLevelCreditManager",
        );
        const receivableLevelCreditManagerContract = await ReceivableLevelCreditManager.deploy();
        await receivableLevelCreditManagerContract.deployed();

        // Deploy Receivable
        const Receivable = await ethers.getContractFactory("Receivable");
        const receivableContract = await Receivable.deploy();
        await receivableContract.deployed();

        return [
            poolConfigContract,
            poolFeeManagerContract,
            poolSafeContract,
            firstLossCoverContract,
            riskAdjustedTranchesPolicyContract,
            fixedSeniorYieldTranchePolicyContract,
            poolContract,
            epochManagerContract,
            trancheVaultContract,
            creditLineContract,
            receivableBackedCreditLineContract,
            receivableFactoringCreditContract,
            creditDueManagerContract,
            borrowerLevelCreditManagerContract,
            receivableBackedCreditLineManagerContract,
            receivableLevelCreditManagerContract,
            receivableContract,
        ];
    }

    // a function that deploys the pool factory and sets implementation addresses
    async function deployPoolFactory(
        humaConfigContract: HumaConfig,
        calendarContract: Calendar,
        poolConfigImpl: PoolConfig,
        poolFeeManagerImpl: PoolFeeManager,
        poolSafeImpl: PoolSafe,
        firstLossCoverImpl: FirstLossCover,
        riskAdjustedTranchesPolicyImpl: RiskAdjustedTranchesPolicy,
        fixedSeniorYieldTranchePolicyImpl: FixedSeniorYieldTranchePolicy,
        poolImpl: Pool,
        epochManagerImpl: EpochManager,
        TrancheVaultImpl: TrancheVault,
        creditLineImpl: CreditLine,
        receivableBackedCreditLineImpl: ReceivableBackedCreditLine,
        receivableFactoringCreditImpl: ReceivableFactoringCredit,
        creditDueManagerImpl: CreditDueManager,
        borrowerLevelCreditManagerImpl: BorrowerLevelCreditManager,
        receivableBackedCreditLineManagerImpl: ReceivableBackedCreditLineManager,
        receivableLevelCreditManagerImpl: ReceivableLevelCreditManager,
        receivableImpl: Receivable,
    ): Promise<PoolFactory> {
        const PoolFactory = await ethers.getContractFactory("PoolFactory");
        const poolFactoryContract = await PoolFactory.deploy(humaConfigContract.address);
        await poolFactoryContract.deployed();

        await poolFactoryContract.addDeployer(defaultDeployer.getAddress());

        // set protocol addresses
        await poolFactoryContract.setCalendarAddress(calendarContract.address);
        await poolFactoryContract.setRiskAdjustedTranchesPolicyImplAddress(
            riskAdjustedTranchesPolicyImpl.address,
        );
        await poolFactoryContract.setFixedSeniorYieldTranchesPolicyImplAddress(
            fixedSeniorYieldTranchePolicyImpl.address,
        );

        await poolFactoryContract.setCreditLineImplAddress(creditLineImpl.address);
        await poolFactoryContract.setReceivableBackedCreditLineImplAddress(
            receivableBackedCreditLineImpl.address,
        );
        await poolFactoryContract.setReceivableFactoringCreditImplAddress(
            receivableFactoringCreditImpl.address,
        );
        await poolFactoryContract.setReceivableLevelCreditManagerImplAddress(
            receivableLevelCreditManagerImpl.address,
        );
        await poolFactoryContract.setReceivableBackedCreditLineManagerImplAddress(
            receivableBackedCreditLineManagerImpl.address,
        );
        await poolFactoryContract.setBorrowerLevelCreditManagerImplAddress(
            borrowerLevelCreditManagerImpl.address,
        );

        await poolFactoryContract.setPoolConfigImplAddress(poolConfigImpl.address);
        await poolFactoryContract.setPoolFeeManagerImplAddress(poolFeeManagerImpl.address);
        await poolFactoryContract.setPoolSafeImplAddress(poolSafeImpl.address);
        await poolFactoryContract.setFirstLossCoverImplAddress(firstLossCoverImpl.address);
        await poolFactoryContract.setPoolImplAddress(poolImpl.address);
        await poolFactoryContract.setEpochManagerImplAddress(epochManagerImpl.address);
        await poolFactoryContract.setTrancheVaultImplAddress(TrancheVaultImpl.address);
        await poolFactoryContract.setCreditDueManagerImplAddress(creditDueManagerImpl.address);
        await poolFactoryContract.setReceivableImplAddress(receivableImpl.address);
        return poolFactoryContract;
    }

    async function prepare() {
        [eaNFTContract, humaConfigContract, mockTokenContract, calendarContract] =
            await deployProtocolContracts(
                protocolOwner,
                treasury,
                eaServiceAccount,
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
            fixedSeniorYieldTranchePolicyImpl,
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

        // deploy pool factory
        poolFactoryContract = await deployPoolFactory(
            humaConfigContract,
            calendarContract,
            poolConfigImpl,
            poolFeeManagerImpl,
            poolSafeImpl,
            firstLossCoverImpl,
            riskAdjustedTranchesPolicyImpl,
            fixedSeniorYieldTranchePolicyImpl,
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
    }

    beforeEach(async function () {
        await loadFixture(prepare);
    });

    // A test that checks the pool factory contract
    it("Deploy a pool using factory", async function () {
        await expect(
            await poolFactoryContract.deployPool(
                "test pool",
                mockTokenContract.address,
                "fixed",
                "creditline",
            ),
        );
    });
});