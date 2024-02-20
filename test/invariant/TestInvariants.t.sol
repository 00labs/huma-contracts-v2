// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {BaseInvariants, PoolDeployParameters} from "./BaseInvariants.sol";
import {LiquidityHandler} from "./handlers/LiquidityHandler.sol";
import {CreditLineHandler} from "./handlers/CreditLineHandler.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";
import {ReceivableBackedCreditLineHandler} from "./handlers/ReceivableBackedCreditLineHandler.sol";

import "forge-std/console.sol";

contract TestInvariants is BaseInvariants {
    uint96 constant MAX_CREDIT_LIMIT = 10_000_000;
    uint96 constant LIQUIDITY_CAP = 10_000_000;
    uint16 constant FIXED_SENIOR_YIELD_BPS = 1000;
    uint16 constant RISK_ADJUSTED_BPS = 1500;
    uint16 constant CREDIT_YIELD_BPS = 1500;

    LiquidityHandler liquidityHandler;
    ReceivableBackedCreditLineHandler rbCreditLineHandler;
    CreditLineHandler creditLineHandler;

    function setUp() public override {
        super.setUp();

        _setUp(
            PoolDeployParameters({
                tranchesPolicyType: FIXED_SENIOR_YIELD_TRANCHES_POLICY,
                // tranchesPolicyType: RISK_ADJUSTED_TRANCHES_POLICY,
                // creditType: RECEIVABLE_BACKED_CREDIT_LINE,
                creditType: CREDIT_LINE,
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
        // rbCreditLineHandler = new ReceivableBackedCreditLineHandler(borrowers);
        // rbCreditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);
        creditLineHandler = new CreditLineHandler(borrowers);
        creditLineHandler.approveBorrowers(_toToken(MAX_CREDIT_LIMIT) / 2, CREDIT_YIELD_BPS);

        addSelector(liquidityHandler.deposit.selector, "deposit");
        addSelector(liquidityHandler.addRedemptionRequest.selector, "addRedemptionRequest");
        addSelector(liquidityHandler.cancelRedemptionRequest.selector, "cancelRedemptionRequest");
        addSelector(liquidityHandler.disburse.selector, "disburse");
        addSelector(liquidityHandler.processYieldForLenders.selector, "processYieldForLenders");
        addSelector(liquidityHandler.withdrawProtocolFee.selector, "withdrawProtocolFee");
        addSelector(liquidityHandler.withdrawPoolOwnerFee.selector, "withdrawPoolOwnerFee");
        addSelector(liquidityHandler.withdrawEAFee.selector, "withdrawEAFee");
        addSelector(creditLineHandler.drawdown.selector, "drawdown");
        addSelector(creditLineHandler.makePayment.selector, "makePayment");
        addSelector(creditLineHandler.refreshCredit.selector, "refreshCredit");
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

        // selectors = new bytes4[](7);
        // selectors[0] = selectors[1] = selectors[2] = rbCreditLineHandler
        //     .drawdownWithReceivable
        //     .selector;
        // selectors[3] = rbCreditLineHandler.makePaymentWithReceivable.selector;
        // selectors[4] = rbCreditLineHandler.makePrincipalPaymentWithReceivable.selector;
        // selectors[5] = rbCreditLineHandler.makePrincipalPaymentAndDrawdownWithReceivable.selector;
        // selectors[6] = rbCreditLineHandler.refreshCredit.selector;
        // targetSelector(FuzzSelector({addr: address(rbCreditLineHandler), selectors: selectors}));
        // targetContract(address(rbCreditLineHandler));

        selectors = new bytes4[](6);
        selectors[0] = selectors[1] = selectors[2] = creditLineHandler.drawdown.selector;
        selectors[3] = selectors[4] = creditLineHandler.makePayment.selector;
        selectors[5] = creditLineHandler.refreshCredit.selector;
        targetSelector(FuzzSelector({addr: address(creditLineHandler), selectors: selectors}));
        targetContract(address(creditLineHandler));
    }

    function testBoundNew1() public {
        uint256 result = liquidityHandler.boundNew(10089, 1000000, 1000000);
        assertEq(result, 1000000);
    }

    function testBoundNew2() public {
        uint256 result = liquidityHandler.boundNew(0, 1000000, 445809192099);
        assertEq(result, 1000000);
    }

    function testDebug() public {
        liquidityHandler.withdrawProtocolFee(6295442937, 18189);
        creditLineHandler.drawdown(5347841, 15670405247728127281328157809421517211, 3);
        creditLineHandler.refreshCredit(4263, 2520);
        liquidityHandler.processYieldForLenders(
            115792089237316195423570985008687907853269984665640564039457584007913129639932,
            1
        );
        liquidityHandler.withdrawEAFee(
            15053351432307361742623713719147652371,
            49043886841868221141937122443539568202564945841499810464828180727528253368149
        );
        // creditLineHandler.refreshCredit(20017, 16397);
        // creditLineHandler.drawdown(15303, 13312, 6668840891114);
        // creditLineHandler.refreshCredit(10075, 17201);
        // liquidityHandler.deposit(
        //     510537666446219246481773878731528714621978,
        //     15610,
        //     83135927887310053417312660604881754261059274354369112460007901204594921022802,
        //     7904743401573
        // );
        // creditLineHandler.refreshCredit(
        //     0,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639935
        // );
        // liquidityHandler.withdrawPoolOwnerFee(
        //     2966213749533447012822919233491949898487911115452453710138800539485707820429,
        //     3389075692647244438667926620621673165930631721915695584711143670
        // );
        // liquidityHandler.processYieldForLenders(
        //     3,
        //     115792089237316195423570985008687907853269984665640564039457584007913129639932
        // );
        // creditLineHandler.makePayment(
        //     73665470,
        //     90000004957,
        //     34240871492120278444382512037462927889707727989256488054029321212407321995947
        // );
        _assert_Tranche_D_E_F();
    }

    function invariant_displayCallsLog() public view {
        displayCallsLog();
    }
}
