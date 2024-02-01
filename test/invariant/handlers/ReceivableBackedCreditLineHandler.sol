// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditHandler} from "./CreditHandler.sol";
import {ReceivableBackedCreditLine} from "contracts/credit/ReceivableBackedCreditLine.sol";
import {ReceivableBackedCreditLineManager} from "contracts/credit/ReceivableBackedCreditLineManager.sol";
import {CreditRecord, CreditConfig, CreditState} from "contracts/credit/CreditStructs.sol";
import {Receivable} from "contracts/credit/Receivable.sol";
import {SECONDS_IN_A_DAY} from "contracts/common/SharedDefs.sol";

import "forge-std/console.sol";

contract ReceivableBackedCreditLineHandler is CreditHandler {
    ReceivableBackedCreditLine rbCreditLine;
    ReceivableBackedCreditLineManager rbCreditLineManager;
    Receivable receivable;

    mapping(address => uint256[]) borrowerReceivables;

    constructor(address[] memory _borrowers) CreditHandler(_borrowers) {
        rbCreditLine = ReceivableBackedCreditLine(poolConfig.credit());
        rbCreditLineManager = ReceivableBackedCreditLineManager(poolConfig.creditManager());
        receivable = Receivable(poolConfig.receivableAsset());
    }

    function approveBorrowers(uint256 creditLimit, uint256 yieldBps) public {
        bytes32 mintRole = receivable.MINTER_ROLE();
        uint256 len = borrowers.length;
        for (uint256 i; i < len; ++i) {
            address borrower = borrowers[i];
            uint256 rand = uint256(keccak256(abi.encodePacked(vm.unixTime(), i)));
            vm.startPrank(eaServiceAccount);
            rbCreditLineManager.approveBorrower(
                borrower,
                uint96(creditLimit),
                uint16(_bound(rand, 1, 12)),
                uint16(yieldBps),
                0,
                0,
                true
            );
            vm.stopPrank();

            vm.startPrank(poolOwner);
            receivable.grantRole(mintRole, borrower);
            vm.stopPrank();
        }
    }

    function drawdownWithReceivable(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.drawdownWithReceivable.selector) advanceTimestamp(timeSeed) {
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowers.length - 1);
        address borrower = borrowers[borrowerIndex];
        (CreditRecord memory cr, ) = rbCreditLine.getDueInfo(borrower);
        if (cr.state != CreditState.Approved && cr.state != CreditState.GoodStanding) return;
        if (cr.remainingPeriods == 0) return;
        if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) return;
        CreditConfig memory cc = rbCreditLineManager.getCreditConfig(
            keccak256(abi.encode(address(rbCreditLine), borrower))
        );
        uint256 maxDrawdownAmount = cc.creditLimit -
            cr.unbilledPrincipal -
            (cr.nextDue - cr.yieldDue);
        uint256 poolAvailableBalance = poolSafe.getAvailableBalanceForPool();
        maxDrawdownAmount = maxDrawdownAmount > poolAvailableBalance
            ? poolAvailableBalance
            : maxDrawdownAmount;
        if (minDrawdownAmount > maxDrawdownAmount) return;
        uint256 drawdownAmount = _boundNew(amountSeed, minDrawdownAmount, maxDrawdownAmount);
        baseInvariants.increaseValidCalls(this.drawdownWithReceivable.selector);
        vm.startPrank(borrower);
        receivable.createReceivable(
            1,
            uint96(drawdownAmount),
            uint64(block.timestamp + 180 * SECONDS_IN_A_DAY),
            "",
            ""
        );
        uint256 receivableId = receivable.tokenOfOwnerByIndex(borrower, 0);
        receivable.approve(address(rbCreditLine), receivableId);
        console.log(
            "valid drawdownWithReceivable - borrower: %s, drawdownAmount: %s, receivableId: %s",
            borrower,
            drawdownAmount,
            receivableId
        );
        rbCreditLine.drawdownWithReceivable(borrower, receivableId, drawdownAmount);
        vm.stopPrank();
        borrowedBorrowers.push(borrower);
        borrowerReceivables[borrower].push(receivableId);
        baseInvariants.setHasProfit(true);
    }

    function makePaymentWithReceivable(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.makePaymentWithReceivable.selector) advanceTimestamp(timeSeed) {
        if (borrowedBorrowers.length == 0) return;
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowedBorrowers.length - 1);
        address borrower = borrowedBorrowers[borrowerIndex];
        (CreditRecord memory cr, ) = rbCreditLine.getDueInfo(borrower);
        if (cr.nextDue == 0 && cr.totalPastDue == 0) return;
        uint256 maxPaymentAmount = creditDueManager.getPayoffAmount(cr);
        if (minPaymentAmount > maxPaymentAmount) return;
        uint256 paymentAmount = _boundNew(amountSeed, minPaymentAmount, maxPaymentAmount * 2);
        baseInvariants.increaseValidCalls(this.makePaymentWithReceivable.selector);
        vm.startPrank(borrower);
        mockToken.mint(borrower, paymentAmount);
        mockToken.approve(address(poolSafe), paymentAmount);
        uint256 index = _boundNew(paymentAmount, 0, borrowerReceivables[borrower].length - 1);
        uint256 receivableId = borrowerReceivables[borrower][index];
        console.log(
            "valid makePaymentWithReceivable - borrower: %s, paymentAmount: %s, receivableId: %s",
            borrower,
            paymentAmount,
            receivableId
        );
        (, bool paidoff) = rbCreditLine.makePaymentWithReceivable(
            borrower,
            receivableId,
            paymentAmount
        );
        vm.stopPrank();
        if (paidoff) {
            _removeItem(borrowedBorrowers, borrowerIndex);
        }
        baseInvariants.setHasProfit(true);
    }

    function makePrincipalPaymentWithReceivable(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.makePrincipalPaymentWithReceivable.selector) advanceTimestamp(timeSeed) {
        if (borrowedBorrowers.length == 0) return;
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowedBorrowers.length - 1);
        address borrower = borrowedBorrowers[borrowerIndex];
        (CreditRecord memory cr, ) = rbCreditLine.getDueInfo(borrower);
        if (cr.state != CreditState.GoodStanding) return;
        if (cr.nextDue == 0 && cr.totalPastDue == 0) return;
        uint256 maxPaymentAmount = creditDueManager.getPayoffAmount(cr);
        if (minPaymentAmount > maxPaymentAmount) return;
        uint256 paymentAmount = _boundNew(amountSeed, minPaymentAmount, maxPaymentAmount * 2);
        baseInvariants.increaseValidCalls(this.makePrincipalPaymentWithReceivable.selector);
        vm.startPrank(borrower);
        mockToken.mint(borrower, paymentAmount);
        mockToken.approve(address(poolSafe), paymentAmount);
        uint256 index = _boundNew(paymentAmount, 0, borrowerReceivables[borrower].length - 1);
        uint256 receivableId = borrowerReceivables[borrower][index];
        console.log(
            "valid makePrincipalPaymentWithReceivable - borrower: %s, paymentAmount: %s, receivableId: %s",
            borrower,
            paymentAmount,
            receivableId
        );
        (, bool paidoff) = rbCreditLine.makePrincipalPaymentWithReceivable(
            borrower,
            receivableId,
            paymentAmount
        );
        vm.stopPrank();
        if (paidoff) {
            _removeItem(borrowedBorrowers, borrowerIndex);
        }
        baseInvariants.setHasProfit(true);
    }

    function makePrincipalPaymentAndDrawdownWithReceivable(
        uint256 borrowerSeed,
        uint256 drawdownAmountSeed,
        uint256 paymentAmountSeed,
        uint256 timeSeed
    )
        public
        logCall(this.makePrincipalPaymentAndDrawdownWithReceivable.selector)
        advanceTimestamp(timeSeed)
    {
        if (borrowedBorrowers.length == 0) return;
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowedBorrowers.length - 1);
        address borrower = borrowedBorrowers[borrowerIndex];
        (CreditRecord memory cr, ) = rbCreditLine.getDueInfo(borrower);
        if (cr.state != CreditState.GoodStanding) return;
        if (cr.remainingPeriods == 0) return;
        if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) return;
        CreditConfig memory cc = rbCreditLineManager.getCreditConfig(
            keccak256(abi.encode(address(rbCreditLine), borrower))
        );
        uint256 maxDrawdownAmount = cc.creditLimit -
            cr.unbilledPrincipal -
            (cr.nextDue - cr.yieldDue);
        uint256 poolAvailableBalance = poolSafe.getAvailableBalanceForPool();
        maxDrawdownAmount = maxDrawdownAmount > poolAvailableBalance
            ? poolAvailableBalance
            : maxDrawdownAmount;
        if (minDrawdownAmount > maxDrawdownAmount) return;
        uint256 drawdownAmount = _boundNew(
            drawdownAmountSeed,
            minDrawdownAmount,
            maxDrawdownAmount
        );
        if (cr.nextDue == 0 && cr.totalPastDue == 0) return;
        uint256 maxPaymentAmount = creditDueManager.getPayoffAmount(cr);
        if (minPaymentAmount > maxPaymentAmount) return;
        uint256 paymentAmount = _boundNew(
            paymentAmountSeed,
            minPaymentAmount,
            maxPaymentAmount * 2
        );
        baseInvariants.increaseValidCalls(
            this.makePrincipalPaymentAndDrawdownWithReceivable.selector
        );
        vm.startPrank(borrower);
        receivable.createReceivable(
            1,
            uint96(drawdownAmount),
            uint64(block.timestamp + 180 * SECONDS_IN_A_DAY),
            "",
            ""
        );
        uint256 drawdownReceivableId = receivable.tokenOfOwnerByIndex(borrower, 0);
        receivable.approve(address(rbCreditLine), drawdownReceivableId);
        mockToken.mint(borrower, paymentAmount);
        mockToken.approve(address(poolSafe), paymentAmount);
        uint256 index = _boundNew(paymentAmount, 0, borrowerReceivables[borrower].length - 1);
        uint256 paymentReceivableId = borrowerReceivables[borrower][index];
        console.log(
            "valid makePrincipalPaymentAndDrawdownWithReceivable - borrower: %s, drawdownAmount: %s, drawdownReceivableId: %s",
            borrower,
            drawdownAmount,
            drawdownReceivableId
        );
        console.log(
            "valid makePrincipalPaymentAndDrawdownWithReceivable - borrower: %s, paymentAmount: %s, paymentReceivableId: %s",
            borrower,
            paymentAmount,
            paymentReceivableId
        );
        (, , bool paidoff) = rbCreditLine.makePrincipalPaymentAndDrawdownWithReceivable(
            borrower,
            paymentReceivableId,
            paymentAmount,
            drawdownReceivableId,
            drawdownAmount
        );
        vm.stopPrank();
        if (paidoff) {
            _removeItem(borrowedBorrowers, borrowerIndex);
        }
        baseInvariants.setHasProfit(true);
    }

    function refreshCredit(
        uint256 borrowerSeed,
        uint256 timeSeed
    ) public logCall(this.refreshCredit.selector) advanceTimestamp(timeSeed) {
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowers.length - 1);
        address borrower = borrowers[borrowerIndex];
        console.log("valid refreshCredit - borrower: %s", borrower);
        baseInvariants.increaseValidCalls(this.refreshCredit.selector);
        vm.startPrank(borrower);
        rbCreditLineManager.refreshCredit(borrower);
        vm.stopPrank();
    }
}
