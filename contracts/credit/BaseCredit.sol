// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "./CreditStructs.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICredit} from "./interfaces/ICredit.sol";

struct CreditCheckpoint {
    uint96 totalAccruedInterest; // total accrued interest from tha loan start
    uint96 totalAccruedPrincipal; // total principal to be repaid from tha loan start todo delete?
    uint64 lastProfitUpdatedTime; // the updated timestamp of totalAccruedInterest and totalAccruedPrincipal
    uint96 totalPaidInterest; // todo delete?
    uint96 totalPaidPrincipal; // todo delete?
    uint64 lastLossUpdatedTime; // the updated timestamp of totalAccruedLoss
    uint96 totalPrincipal; // todo delete?
    uint96 totalAccruedLoss;
}

struct CreditDueInfo {
    uint64 dueDate; // the due date of the next payment
    uint96 unbilledPrincipal; // the amount of principal not included in the bill
    uint96 totalDue; // the due amount of the next payment
    uint96 feesAndInterestDue; // interest and fees due for the next payment
    uint16 remainingPeriods; // # of payment periods until the maturity of the credit line
    uint16 missedPeriods; // # of consecutive missed payments, for default processing
}

struct CreditInfo {
    uint64 startTime; // loan start timestamp
    CreditState state;
    CreditCheckpoint checkPoint;
}

enum CreditState {
    Deleted,
    Requested,
    Approved,
    GoodStanding,
    Delayed,
    Defaulted
}

struct CreditLimit {
    address borrower; // loan borrower address
    uint96 creditLimit; // the max borrowed amount
}

contract BaseCredit is ICredit {
    ICreditFeeManager public feeManager;

    mapping(bytes32 => CreditLimit) public creditLimits;
    mapping(bytes32 => CreditConfig) public creditConfigs;
    mapping(bytes32 => CreditInfo) public credits;
    mapping(bytes32 => CreditDueInfo) public creditDues;

    bytes32[] public activeCreditsHash;
    bytes32[] public overdueCreditsHash;

    uint256 public totalAccruedProfit;
    uint256 public totalAccruedLoss;
    uint256 public totalAccruedLossRecovery;

    function _approve(
        bytes32 creditHash,
        address borrower,
        uint256 creditLimit,
        CreditConfig calldata dealConfig
    ) internal {
        // only EA

        CreditLimit memory cl = creditLimits[creditHash];
        if (cl.borrower != address(0)) revert();

        _createCreditConfig(creditHash, dealConfig);
    }

    /**
     * @notice Creates loan config data
     * @param creditHash a unique hash for the loan
     * @param dealConfig the schedule and payment parameters for this loan
     */
    function _createCreditConfig(bytes32 creditHash, CreditConfig memory dealConfig) internal {
        creditConfigs[creditHash] = dealConfig;
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) public virtual {
        // only borrower or approved address borrower

        CreditLimit memory creditLimit = creditLimits[creditHash];

        _borrowFromCredit(creditHash, borrowAmount);

        // transfer borrowAmount to borrower
    }

    /**
     * @notice Updates loan data when borrowers borrow
     * @param creditHash a unique hash for the loan
     * @param amount borrowed amount
     */
    function _borrowFromCredit(bytes32 creditHash, uint256 amount) internal {
        // check parameters & permission

        CreditInfo memory creditInfo = credits[creditHash];

        if (creditInfo.startTime == 0) {
            // the first drawdown

            // initialize a loan
            creditInfo.startTime = uint64(block.timestamp);
            creditInfo.checkPoint.totalPrincipal = uint96(amount);
            creditInfo.state = CreditState.GoodStanding;
            creditInfo.checkPoint.lastProfitUpdatedTime = uint64(block.timestamp);
        } else {
            // drawdown for an existing loan

            uint256 accruedInterest;
            uint256 accruedPrincipalLoss;

            // update loan data(interest, principal) to current time
            (accruedInterest, accruedPrincipalLoss) = _refreshCredit(creditHash, creditInfo);

            if (accruedInterest > 0) totalAccruedProfit += accruedInterest;
            if (accruedPrincipalLoss > 0) totalAccruedLoss += accruedPrincipalLoss;

            // update the drawdown amount
            creditInfo.checkPoint.totalPrincipal += uint96(amount);
        }

        // store loan data
        credits[creditHash] = creditInfo;

        // :update credit due to current time
        // :update totalDue and unbilledPrincipal
    }

    function _refreshCredit(
        bytes32 creditHash,
        CreditInfo memory creditInfo
    ) internal view returns (uint256 accruedInterest, uint256 accruedPrincipalLoss) {
        CreditConfig memory creditConfig = creditConfigs[creditHash];
        CreditDueInfo memory creditDue = creditDues[creditHash];

        if (creditInfo.state == CreditState.GoodStanding && _isOverdue(creditDue.dueDate)) {
            // :move credit from active array to overdue array
            // :update credit state to overdue
        }

        // :if credit is active(GoodStanding?)
        accruedInterest = _refreshCreditProfit(creditInfo, creditConfig);
        // :return

        // :if credit is overdue(delayed?)
        accruedPrincipalLoss = _refreshCreditLoss(creditInfo, creditConfig);
        // :return
    }

    function _refreshCreditProfit(
        CreditInfo memory creditInfo,
        CreditConfig memory creditConfig
    ) internal view returns (uint256) {
        (uint256 accruedInterest, uint256 accruedPrincipal) = feeManager.accruedDebt(
            creditInfo.checkPoint.totalPrincipal - creditInfo.checkPoint.totalPaidPrincipal,
            creditInfo.startTime,
            creditInfo.checkPoint.lastProfitUpdatedTime,
            creditConfig
        );
        creditInfo.checkPoint.totalAccruedInterest += uint96(accruedInterest);
        creditInfo.checkPoint.totalAccruedPrincipal += uint96(accruedPrincipal);
        creditInfo.checkPoint.lastProfitUpdatedTime = uint64(block.timestamp);

        return accruedInterest;
    }

    function _refreshCreditLoss(
        CreditInfo memory creditInfo,
        CreditConfig memory creditConfig
    ) internal view returns (uint256) {
        uint256 loss;
        // :calculate accrued credit loss

        creditInfo.checkPoint.totalAccruedLoss += uint96(loss);
        creditInfo.checkPoint.lastLossUpdatedTime = uint64(block.timestamp);

        return loss;
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        CreditLimit memory creditLimit = creditLimits[creditHash];

        _payToCredit(creditHash, amount);

        // transfer amount from msg.sender
    }

    /**
     * @notice Updates loan data when borrowers pay
     * @param creditHash a unique hash for the loan
     * @param amount paid amount
     */
    function _payToCredit(bytes32 creditHash, uint256 amount) internal {
        // check parameters & permission

        CreditInfo memory creditInfo = credits[creditHash];

        // :update due info

        // update loan data(interest, principal) to current time
        (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
            creditHash,
            creditInfo
        );

        if (creditInfo.state == CreditState.GoodStanding) {
            totalAccruedProfit += accruedInterest;
        } else if (creditInfo.state == CreditState.Delayed) {
            totalAccruedLoss += accruedPrincipalLoss;
            CreditConfig memory creditConfig = creditConfigs[creditHash];
            accruedInterest = _refreshCreditProfit(creditInfo, creditConfig);
            totalAccruedProfit += accruedInterest;
        }

        // update paid interest
        uint256 interestPart = creditInfo.checkPoint.totalAccruedInterest -
            creditInfo.checkPoint.totalPaidInterest;
        interestPart = amount > interestPart ? interestPart : amount;
        creditInfo.checkPoint.totalPaidInterest += uint96(interestPart);

        // update paid principal
        uint256 remaining = amount - interestPart;
        uint256 principalPart = creditInfo.checkPoint.totalAccruedPrincipal >
            creditInfo.checkPoint.totalPaidPrincipal
            ? creditInfo.checkPoint.totalAccruedPrincipal -
                creditInfo.checkPoint.totalPaidPrincipal
            : 0;

        // :handle payoff
        // :if payoff remove credit from active/overdue array and set recovered to true
        bool fullPayment;

        if (remaining >= principalPart) {
            // :if credit is overdue, move credit to active array
            fullPayment = true;
        }
        creditInfo.checkPoint.totalPaidPrincipal += uint96(remaining);

        if (fullPayment) {
            // :generate next due info

            uint256 lossPart = creditInfo.checkPoint.totalAccruedLoss > totalAccruedLoss
                ? totalAccruedLoss
                : creditInfo.checkPoint.totalAccruedLoss;
            totalAccruedLoss -= lossPart;
            creditInfo.checkPoint.totalAccruedLoss -= uint96(lossPart);
            if (creditInfo.checkPoint.totalAccruedLoss > 0) {
                totalAccruedLossRecovery += creditInfo.checkPoint.totalAccruedLoss;
                creditInfo.checkPoint.totalAccruedLoss = 0;
            }
        }
    }

    function refreshPnL() external returns (uint256 profit, uint256 loss, uint256 lossRecovery) {
        profit = totalAccruedProfit;
        loss = totalAccruedLoss;
        lossRecovery = totalAccruedLossRecovery;

        uint256 activeHashCount = activeCreditsHash.length;
        uint256 overdueHashCount = overdueCreditsHash.length;
        bytes32[] memory hashs = new bytes32[](activeHashCount + overdueHashCount);

        for (uint256 i; i < activeHashCount; i++) {
            hashs[i] = activeCreditsHash[i];
        }

        for (uint256 i; i < overdueHashCount; i++) {
            hashs[activeHashCount + i] = overdueCreditsHash[i];
        }

        // Iterate all active credits to get the total profit
        for (uint256 i; i < activeHashCount + overdueHashCount; i++) {
            bytes32 hash = hashs[i];
            CreditInfo memory creditInfo = credits[hash];
            (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
                hash,
                creditInfo
            );
            credits[hash] = creditInfo;

            if (accruedInterest > 0) profit += accruedInterest;
            if (accruedPrincipalLoss > 0) loss += accruedPrincipalLoss;
        }

        if (loss >= lossRecovery) {
            loss -= lossRecovery;
            lossRecovery = 0;
        } else {
            lossRecovery -= loss;
            loss = 0;
        }

        totalAccruedProfit = 0;
        totalAccruedLoss = 0;
        totalAccruedLossRecovery = 0;
    }

    function currentPnL()
        external
        view
        returns (uint256 profit, uint256 loss, uint256 lossRecovery)
    {
        profit = totalAccruedProfit;
        loss = totalAccruedLoss;
        lossRecovery = totalAccruedLossRecovery;

        uint256 activeHashCount = activeCreditsHash.length;
        uint256 overdueHashCount = overdueCreditsHash.length;
        bytes32[] memory hashs = new bytes32[](activeHashCount + overdueHashCount);

        for (uint256 i; i < activeHashCount; i++) {
            hashs[i] = activeCreditsHash[i];
        }

        for (uint256 i; i < overdueHashCount; i++) {
            hashs[activeHashCount + i] = overdueCreditsHash[i];
        }

        // Iterate all active credits to get the total profit
        for (uint256 i; i < activeHashCount + overdueHashCount; i++) {
            bytes32 hash = activeCreditsHash[i];
            CreditInfo memory creditInfo = credits[hash];
            (uint256 accruedInterest, uint256 accruedPrincipalLoss) = _refreshCredit(
                hash,
                creditInfo
            );

            if (accruedInterest > 0) profit += accruedInterest;
            if (accruedPrincipalLoss > 0) loss += accruedPrincipalLoss;
        }

        if (loss >= lossRecovery) {
            loss -= lossRecovery;
            lossRecovery = 0;
        } else {
            lossRecovery -= loss;
            loss = 0;
        }
    }

    function submitPrincipalWithdrawal(uint256 amount) external {}

    function _isOverdue(uint256 dueDate) internal view returns (bool) {}

    // todo provide an external view function for credit payment due list ?
}
