// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {CreditHandler} from "./CreditHandler.sol";
import {CreditLine} from "contracts/credit/CreditLine.sol";
import {CreditLineManager} from "contracts/credit/CreditLineManager.sol";
import {CreditRecord, CreditConfig, CreditState} from "contracts/credit/CreditStructs.sol";

import "forge-std/console.sol";

contract CreditLineHandler is CreditHandler {
    CreditLine creditLine;
    CreditLineManager creditLineManager;

    constructor(address[] memory _borrowers) CreditHandler(_borrowers) {
        creditLine = CreditLine(poolConfig.credit());
        creditLineManager = CreditLineManager(poolConfig.creditManager());
    }

    function approveBorrowers(uint256 creditLimit, uint256 yieldBps) public {
        vm.startPrank(evaluationAgent);
        for (uint256 i; i < borrowers.length; i++) {
            address borrower = borrowers[i];
            uint256 rand = uint256(keccak256(abi.encodePacked(vm.unixTime(), i)));
            creditLineManager.approveBorrower(
                borrower,
                uint96(creditLimit),
                uint16(_bound(rand, 1, 12)),
                uint16(yieldBps),
                0,
                0,
                true
            );
        }
        vm.stopPrank();
    }

    function drawdown(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.drawdown.selector) advanceTimestamp(timeSeed) {
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowers.length - 1);
        address borrower = borrowers[borrowerIndex];
        (CreditRecord memory cr, ) = creditLine.getDueInfo(borrower);
        if (cr.state != CreditState.Approved && cr.state != CreditState.GoodStanding) return;
        if (cr.remainingPeriods == 0) return;
        if (cr.nextDue != 0 && block.timestamp > cr.nextDueDate) return;
        CreditConfig memory cc = creditLineManager.getCreditConfig(
            keccak256(abi.encode(address(creditLine), borrower))
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
        console.log("valid drawdown - borrower: %s, drawdownAmount: %s", borrower, drawdownAmount);
        baseInvariants.increaseValidCalls(this.drawdown.selector);
        vm.startPrank(borrower);
        creditLine.drawdown(drawdownAmount);
        vm.stopPrank();
        if (!borrowerBorrowed[borrower]) {
            borrowedBorrowers.push(borrower);
            borrowerBorrowed[borrower] = true;
        }
        baseInvariants.setHasProfit(true);
    }

    function makePayment(
        uint256 borrowerSeed,
        uint256 amountSeed,
        uint256 timeSeed
    ) public logCall(this.makePayment.selector) advanceTimestamp(timeSeed) {
        if (borrowedBorrowers.length == 0) return;
        uint256 borrowerIndex = _boundNew(borrowerSeed, 0, borrowedBorrowers.length - 1);
        address borrower = borrowedBorrowers[borrowerIndex];
        (CreditRecord memory cr, ) = creditLine.getDueInfo(borrower);
        if (cr.nextDue == 0 && cr.totalPastDue == 0) return;
        uint256 maxPaymentAmount = creditDueManager.getPayoffAmount(cr);
        uint256 paymentAmount = _boundNew(amountSeed, minPaymentAmount, maxPaymentAmount * 2);
        console.log(
            "valid makePayment - borrower: %s, paymentAmount: %s",
            borrower,
            paymentAmount
        );
        baseInvariants.increaseValidCalls(this.makePayment.selector);
        vm.startPrank(borrower);
        mockToken.mint(borrower, paymentAmount);
        mockToken.approve(address(poolSafe), paymentAmount);
        creditLine.makePayment(borrower, paymentAmount);
        vm.stopPrank();
        if (paymentAmount >= maxPaymentAmount) {
            _removeItem(borrowedBorrowers, borrowerIndex);
            borrowerBorrowed[borrower] = false;
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
        creditLineManager.refreshCredit(borrower);
        vm.stopPrank();
    }
}
