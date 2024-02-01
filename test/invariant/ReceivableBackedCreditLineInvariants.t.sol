// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseInvariants, PoolDeployParameters} from "./BaseInvariants.sol";
import {LiquidityHandler} from "./handlers/LiquidityHandler.sol";
import {ReceivableBackedCreditLineHandler} from "./handlers/ReceivableBackedCreditLineHandler.sol";
import {ReceivableBackedCreditLineManager} from "contracts/credit/ReceivableBackedCreditLineManager.sol";
import {CreditConfig} from "contracts/credit/CreditStructs.sol";

contract ReceivableBackedCreditLineInvariants is BaseInvariants {
    uint96 constant MAX_CREDIT_LIMIT = 10_000_000;
    uint96 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant CREDIT_YIELD_BPS = 1500;

    LiquidityHandler liquidityHandler;
    ReceivableBackedCreditLineHandler rbCreditLineHandler;

    function setUp() public override {
        super.setUp();

        _setUp(
            PoolDeployParameters({
                tranchesPolicyType: RISK_ADJUSTED_TRANCHES_POLICY,
                creditType: RECEIVABLE_BACKED_CREDIT_LINE,
                maxCreditLimit: MAX_CREDIT_LIMIT,
                liquidityCap: LIQUIDITY_CAP,
                fixedSeniorYieldBps: FIXED_SENIOR_YIELD_BPS,
                riskAdjustedBps: RISK_ADJUSTED_BPS,
                creditYieldBps: CREDIT_YIELD_BPS
            }),
            10,
            10
        );

        liquidityHandler = new LiquidityHandler(lenders);
        rbCreditLineHandler = new ReceivableBackedCreditLineHandler(borrowers);
        rbCreditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);

        addSelector(liquidityHandler.deposit.selector, "deposit");
        addSelector(liquidityHandler.addRedemptionRequest.selector, "addRedemptionRequest");
        addSelector(liquidityHandler.cancelRedemptionRequest.selector, "cancelRedemptionRequest");
        addSelector(liquidityHandler.disburse.selector, "disburse");
        addSelector(liquidityHandler.processYieldForLenders.selector, "processYieldForLenders");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(liquidityHandler.withdrawPoolOwnerFee.selector, "withdrawPoolOwnerFee");
        addSelector(liquidityHandler.withdrawEAFee.selector, "withdrawEAFee");
        addSelector(rbCreditLineHandler.drawdownWithReceivable.selector, "drawdownWithReceivable");
        addSelector(
            rbCreditLineHandler.makePaymentWithReceivable.selector,
            "makePaymentWithReceivable"
        );
        addSelector(
            rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector,
            "makePrincipalPaymentWithReceivable"
        );
        addSelector(
            rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector,
            "makePrincipalPaymentAndDrawdownWithReceivable"
        );
        addSelector(rbCreditLineHandler.refreshCredit.selector, "refreshCredit");

        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = selectors[1] = selectors[2] = liquidityHandler.deposit.selector;
        selectors[3] = selectors[4] = liquidityHandler.addRedemptionRequest.selector;
        selectors[5] = liquidityHandler.cancelRedemptionRequest.selector;
        selectors[6] = liquidityHandler.disburse.selector;
        selectors[7] = liquidityHandler.processYieldForLenders.selector;
        selectors[8] = liquidityHandler.withdrawProtocolFee.selector;
        selectors[9] = liquidityHandler.withdrawPoolOwnerFee.selector;
        selectors[10] = liquidityHandler.withdrawEAFee.selector;
        targetSelector(FuzzSelector({addr: address(liquidityHandler), selectors: selectors}));
        targetContract(address(liquidityHandler));

        selectors = new bytes4[](7);
        selectors[0] = selectors[1] = selectors[2] = rbCreditLineHandler
            .drawdownWithReceivable
            .selector;
        selectors[3] = rbCreditLineHandler.makePaymentWithReceivable.selector;
        selectors[4] = rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector;
        selectors[5] = rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector;
        selectors[6] = rbCreditLineHandler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(rbCreditLineHandler), selectors: selectors}));
        targetContract(address(rbCreditLineHandler));
    }

    function test_RBCredit_invariants() public {
        _assert_Credit_A_B_C_D();
        _assert_RBCredit_E();
    }

    function invariant_RBCredit_A_B_C_D() public {
        _assert_Credit_A_B_C_D();
    }

    function invariant_RBCredit_E() public {
        _assert_RBCredit_E();
    }

    function _assert_RBCredit_E() internal {
        ReceivableBackedCreditLineManager rbCreditLineManager = ReceivableBackedCreditLineManager(
            address(creditManager)
        );
        uint256 len = borrowers.length;
        uint256 timestamp = block.timestamp;
        for (uint256 i = 0; i < len; ++i) {
            address borrower = borrowers[i];
            string memory borrowerStr = string.concat(vm.toString(i), ", ", vm.toString(borrower));
            bytes32 hash = keccak256(abi.encode(address(creditLine), borrower));
            CreditConfig memory cc = creditManager.getCreditConfig(hash);
            assertGe(
                cc.creditLimit,
                rbCreditLineManager.getAvailableCredit(hash),
                string.concat("RBCredit Invariant E - ", borrowerStr)
            );
        }
    }
}
