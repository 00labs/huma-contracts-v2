// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {MockToken} from "contracts/common/mock/MockToken.sol";
import {HumaConfig} from "contracts/common/HumaConfig.sol";
import {EvaluationAgentNFT} from "contracts/common/EvaluationAgentNFT.sol";
import {PoolFactory} from "contracts/factory/PoolFactory.sol";
import {PoolFactoryForTest} from "./PoolFactoryForTest.sol";
import {PoolConfig, AdminRnR, LPConfig, FirstLossCoverConfig} from "contracts/common/PoolConfig.sol";
import {PoolFeeManager} from "contracts/liquidity/PoolFeeManager.sol";
import {PoolSafe} from "contracts/liquidity/PoolSafe.sol";
import {FirstLossCover} from "contracts/liquidity/FirstLossCover.sol";
import {FixedSeniorYieldTranchePolicy} from "contracts/liquidity/FixedSeniorYieldTranchesPolicy.sol";
import {RiskAdjustedTranchesPolicy} from "contracts/liquidity/RiskAdjustedTranchesPolicy.sol";
import {Pool} from "contracts/liquidity/Pool.sol";
import {EpochManager} from "contracts/liquidity/EpochManager.sol";
import {TrancheVault} from "contracts/liquidity/TrancheVault.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditDueManager} from "contracts/credit/CreditDueManager.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";
import {ReceivableBackedCreditLine} from "contracts/credit/ReceivableBackedCreditLine.sol";
import {ReceivableBackedCreditLineManager} from "contracts/credit/ReceivableBackedCreditLineManager.sol";
import {ReceivableFactoringCredit} from "contracts/credit/ReceivableFactoringCredit.sol";
import {ReceivableFactoringCreditManager} from "contracts/credit/ReceivableFactoringCreditManager.sol";
import {Receivable} from "contracts/credit/Receivable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Calendar} from "contracts/common/Calendar.sol";
import {BORROWER_LOSS_COVER_INDEX, ADMIN_LOSS_COVER_INDEX} from "contracts/common/SharedDefs.sol";

import {TrancheVaultHandler} from "./handlers/TrancheVaultHandler.sol";

import {Test, Vm} from "forge-std/Test.sol";
import "forge-std/console.sol";

contract BaseTest is Test {
    address treasury;
    address protocolOwner;
    address eaServiceAccount;
    address sentinelServiceAccount;
    address poolOwner;
    address poolOperator;
    address poolOwnerTreasury;
    address evaluationAgent;
    address borrower;

    address[] lenders;
    address[] borrowers;

    MockToken mockToken;
    HumaConfig humaConfig;
    EvaluationAgentNFT evaluationAgentNFT;

    PoolFactoryForTest poolFactory;
    Receivable receivable;

    uint256 poolId;

    string constant FIXED_SENIOR_YIELD_TRANCHES_POLICY = "fixed";
    string constant RISK_ADJUSTED_TRANCHES_POLICY = "adjusted";
    string constant CREDIT_LINE = "creditline";
    string constant RECEIVABLE_BACKED_CREDIT_LINE = "receivablebacked";
    string constant RECEIVABLE_FACTORING_CREDIT = "receivablefactoring";

    TrancheVaultHandler trancheVaultHandler;

    function setUp() public virtual {
        _createAccounts();
        _deployProtocolContracts();
        _deployFactory();
        _deployReceivableWithFactory();
    }

    function _createAccounts() internal {
        protocolOwner = makeAddr("protocolOwner");
        treasury = makeAddr("treasury");
        eaServiceAccount = makeAddr("eaServiceAccount");
        sentinelServiceAccount = makeAddr("sentinelServiceAccount");
        poolOwner = makeAddr("poolOwner");
        poolOperator = makeAddr("poolOperator");
        poolOwnerTreasury = makeAddr("poolOwnerTreasury");
        evaluationAgent = makeAddr("evaluationAgent");
        borrower = makeAddr("borrower");
    }

    function _deployProtocolContracts() internal {
        humaConfig = new HumaConfig();
        evaluationAgentNFT = new EvaluationAgentNFT();
        mockToken = new MockToken();

        humaConfig.setHumaTreasury(treasury);
        humaConfig.setEANFTContractAddress(address(evaluationAgentNFT));
        humaConfig.setEAServiceAccount(eaServiceAccount);
        humaConfig.setSentinelServiceAccount(sentinelServiceAccount);
        humaConfig.addPauser(protocolOwner);
        humaConfig.addPauser(poolOwner);

        humaConfig.transferOwnership(protocolOwner);
        vm.startPrank(protocolOwner);
        if (humaConfig.paused()) {
            humaConfig.unpause();
        }
        humaConfig.setLiquidityAsset(address(mockToken), true);
        vm.stopPrank();
    }

    function _deployFactory() internal {
        poolFactory = PoolFactoryForTest(
            address(new ERC1967Proxy(address(new PoolFactoryForTest()), ""))
        );
        poolFactory.initialize(address(humaConfig));
        poolFactory.addDeployer(address(this));
        poolFactory.setCalendarAddress(address(new Calendar()));

        poolFactory.setPoolConfigImplAddress(address(new PoolConfig()));
        poolFactory.setPoolFeeManagerImplAddress(address(new PoolFeeManager()));
        poolFactory.setPoolSafeImplAddress(address(new PoolSafe()));
        poolFactory.setFirstLossCoverImplAddress(address(new FirstLossCover()));
        poolFactory.setPoolImplAddress(address(new Pool()));
        poolFactory.setEpochManagerImplAddress(address(new EpochManager()));
        poolFactory.setTrancheVaultImplAddress(address(new TrancheVault()));
        poolFactory.setRiskAdjustedTranchesPolicyImplAddress(
            address(new RiskAdjustedTranchesPolicy())
        );
        poolFactory.setFixedSeniorYieldTranchesPolicyImplAddress(
            address(new FixedSeniorYieldTranchePolicy())
        );

        poolFactory.setCreditDueManagerImplAddress(address(new CreditDueManager()));
        poolFactory.setCreditLineImplAddress(address(new CreditLine()));
        poolFactory.setCreditLineManagerImplAddress(address(new CreditLineManager()));
        poolFactory.setReceivableBackedCreditLineImplAddress(
            address(new ReceivableBackedCreditLine())
        );
        poolFactory.setReceivableBackedCreditLineManagerImplAddress(
            address(new ReceivableBackedCreditLineManager())
        );
        poolFactory.setReceivableFactoringCreditImplAddress(
            address(new ReceivableFactoringCredit())
        );
        poolFactory.setReceivableFactoringCreditManagerImplAddress(
            address(new ReceivableFactoringCreditManager())
        );
        poolFactory.setReceivableImplAddress(address(new Receivable()));
    }

    function _deployReceivableWithFactory() internal {
        vm.recordLogs();
        poolFactory.addReceivable(poolOwner);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == keccak256("ReceivableCreated(address)")) {
                receivable = Receivable(address(bytes20(entries[i].data)));
                break;
            }
        }
    }

    function _deployPool(string memory tranchesPolicyType, string memory creditType) internal {
        poolFactory.deployPool(
            "test pool",
            address(mockToken),
            address(receivable),
            tranchesPolicyType,
            creditType
        );
        poolId = poolFactory.poolId();
        poolFactory.addPoolOperator(poolId, poolOperator);
        poolFactory.addPoolOwner(poolId, poolOwner);
        poolFactory.updatePoolStatus(poolId, PoolFactory.PoolStatus.Initialized);
    }

    function _enablePool() internal {
        PoolFactory.PoolRecord memory poolRecord = poolFactory.checkPool(poolId);
        PoolConfig poolConfig = PoolConfig(poolRecord.poolConfigAddress);
        vm.startPrank(poolOwner);
        poolConfig.setPoolOwnerTreasury(poolOwnerTreasury);
        vm.recordLogs();
        evaluationAgentNFT.mintNFT(evaluationAgent);
        Vm.Log[] memory entries = vm.getRecordedLogs();
        uint256 eaNFTTokenId;
        for (uint256 i = 0; i < entries.length; i++) {
            if (entries[i].topics[0] == keccak256("NFTGenerated(uint256,address)")) {
                (eaNFTTokenId, ) = abi.decode(entries[i].data, (uint256, address));
                break;
            }
        }
        poolConfig.setEvaluationAgent(eaNFTTokenId, evaluationAgent);

        FirstLossCover adminFLC = FirstLossCover(
            poolConfig.getFirstLossCover(ADMIN_LOSS_COVER_INDEX)
        );
        adminFLC.addCoverProvider(poolOwnerTreasury);
        adminFLC.addCoverProvider(evaluationAgent);
        FirstLossCover borrowerFLC = FirstLossCover(
            poolConfig.getFirstLossCover(BORROWER_LOSS_COVER_INDEX)
        );
        borrowerFLC.addCoverProvider(borrower);

        vm.stopPrank();

        AdminRnR memory adminRnR = poolConfig.getAdminRnR();
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        FirstLossCoverConfig memory flcConfig = poolConfig.getFirstLossCoverConfig(
            address(adminFLC)
        );
        vm.startPrank(poolOwnerTreasury);
        mockToken.approve(poolConfig.poolSafe(), type(uint256).max);
        mockToken.approve(address(adminFLC), type(uint256).max);
        uint256 amount = (lpConfig.liquidityCap * adminRnR.liquidityRateInBpsByPoolOwner) / 10000;
        mockToken.mint(poolOwnerTreasury, amount);
        TrancheVault(poolConfig.juniorTranche()).makeInitialDeposit(amount);
        amount = flcConfig.minLiquidity / 2;
        mockToken.mint(poolOwnerTreasury, amount);
        adminFLC.depositCover(amount);
        vm.stopPrank();

        vm.startPrank(evaluationAgent);
        mockToken.approve(poolConfig.poolSafe(), type(uint256).max);
        mockToken.approve(address(adminFLC), type(uint256).max);
        amount = (lpConfig.liquidityCap * adminRnR.liquidityRateInBpsByEA) / 10000;
        mockToken.mint(evaluationAgent, amount);
        TrancheVault(poolConfig.juniorTranche()).makeInitialDeposit(amount);
        amount = flcConfig.minLiquidity / 2;
        mockToken.mint(evaluationAgent, amount);
        adminFLC.depositCover(amount);
        vm.stopPrank();

        vm.startPrank(poolOperator);
        TrancheVault(poolConfig.juniorTranche()).setReinvestYield(poolOwnerTreasury, true);
        TrancheVault(poolConfig.juniorTranche()).setReinvestYield(evaluationAgent, true);
        vm.stopPrank();

        vm.startPrank(borrower);
        flcConfig = poolConfig.getFirstLossCoverConfig(address(borrowerFLC));
        mockToken.approve(address(borrowerFLC), type(uint256).max);
        mockToken.mint(borrower, flcConfig.minLiquidity);
        borrowerFLC.depositCover(flcConfig.minLiquidity);
        vm.stopPrank();

        vm.startPrank(poolOwner);
        Pool(poolConfig.pool()).enablePool();
        vm.stopPrank();
    }

    function _createUsers(uint256 lenderNum, uint256 borrowerNum) internal {
        TrancheVault juniorTranche = TrancheVault(
            PoolConfig(poolFactory.checkPool(poolId).poolConfigAddress).juniorTranche()
        );
        TrancheVault seniorTranche = TrancheVault(
            PoolConfig(poolFactory.checkPool(poolId).poolConfigAddress).seniorTranche()
        );
        for (uint256 i; i < lenderNum; i++) {
            address lender = makeAddr(string(abi.encode("lender", i)));
            vm.startPrank(poolOperator);
            bool reinvesting = i % 2 == 0 ? true : false;
            juniorTranche.addApprovedLender(lender, reinvesting);
            seniorTranche.addApprovedLender(lender, reinvesting);
            vm.stopPrank();
            lenders.push(lender);
        }
        for (uint256 i; i < borrowerNum; i++) {
            borrowers.push(makeAddr(string(abi.encode("borrower", i))));
        }
    }

    function _toToken(uint256 amount) internal view returns (uint256) {
        return amount * 10 ** mockToken.decimals();
    }
}
