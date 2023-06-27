// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {CreditConfig} from "./CreditStructs.sol";
import {ICreditFeeManager} from "./utils/interfaces/ICreditFeeManager.sol";
import {ICredit} from "./interfaces/ICredit.sol";

struct CreditCheckpoint {
    uint96 totalAccruedInterest; // total accrued interest from tha loan start
    uint96 totalAccruedPrincipal; // total principal to be repaid from tha loan start
    uint64 lastUpdatedTime; // the updated timestamp of totalAccruedInterest and totalAccruedPrincipal
    uint96 totalPrincipal;
    uint96 totalPaidInterest;
    uint96 totalPaidPrincipal;
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
    mapping(bytes32 => CreditConfig) public dealConfigs;
    mapping(bytes32 => CreditInfo) public deals;

    bytes32[] public activeCreditsHash;

    uint256 public accruedProfit;
    uint256 public accruedLoss;

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
     * @param dealHash a unique hash for the loan
     * @param dealConfig the schedule and payment parameters for this loan
     */
    function _createCreditConfig(bytes32 dealHash, CreditConfig memory dealConfig) internal {
        dealConfigs[dealHash] = dealConfig;
    }

    function drawdown(bytes32 creditHash, uint256 borrowAmount) public virtual {
        // only borrower or approved address borrower

        CreditLimit memory cl = creditLimits[creditHash];

        _borrowFromCredit(creditHash, borrowAmount);

        // transfer borrowAmount to borrower
    }

    /**
     * @notice Updates loan data when borrowers borrow
     * @param dealHash a unique hash for the loan
     * @param amount borrowed amount
     */
    function _borrowFromCredit(bytes32 dealHash, uint256 amount) internal {
        // check parameters & permission

        CreditInfo memory di = deals[dealHash];

        if (di.startTime == 0) {
            // the first drawdown

            // initialize a loan
            di.startTime = uint64(block.timestamp);
            di.checkPoint.totalPrincipal = uint96(amount);
            di.state = CreditState.GoodStanding;
            di.checkPoint.lastUpdatedTime = uint64(block.timestamp);
        } else {
            // drawdown for an existing loan

            uint256 accruedInterest;

            // update loan data(interest, principal) to current time
            (di, accruedInterest) = _refreshCredit(dealHash, di);

            accruedProfit += accruedInterest;

            // update the drawdown amount
            di.checkPoint.totalPrincipal += uint96(amount);
        }

        // store loan data
        deals[dealHash] = di;
    }

    function _refreshCredit(
        bytes32 dealHash,
        CreditInfo memory di
    ) internal view returns (CreditInfo memory, uint256) {
        (uint256 accruedInterest, uint256 accruedPrincipal) = feeManager.accruedDebt(
            di.checkPoint.totalPrincipal - di.checkPoint.totalPaidPrincipal,
            di.startTime,
            di.checkPoint.lastUpdatedTime,
            dealConfigs[dealHash]
        );
        di.checkPoint.totalAccruedInterest += uint96(accruedInterest);
        di.checkPoint.totalAccruedPrincipal += uint96(accruedPrincipal);
        di.checkPoint.lastUpdatedTime = uint64(block.timestamp);

        return (di, accruedInterest);
    }

    function makePayment(
        bytes32 creditHash,
        uint256 amount
    ) public virtual returns (uint256 amountPaid, bool paidoff) {
        CreditLimit memory cl = creditLimits[creditHash];

        _payToCredit(creditHash, amount);

        // transfer amount from msg.sender
    }

    /**
     * @notice Updates loan data when borrowers pay
     * @param dealHash a unique hash for the loan
     * @param amount paid amount
     */
    function _payToCredit(bytes32 dealHash, uint256 amount) internal {
        // check parameters & permission

        CreditInfo memory di = deals[dealHash];
        uint256 accruedInterest;

        // update loan data(interest, principal) to current time
        (di, accruedInterest) = _refreshCredit(dealHash, di);

        accruedProfit += accruedInterest;

        // update paid interest
        uint256 interestPart = di.checkPoint.totalAccruedInterest -
            di.checkPoint.totalPaidInterest;
        interestPart = amount > interestPart ? interestPart : amount;
        di.checkPoint.totalPaidInterest += uint96(interestPart);

        // update paid principal
        if (amount > interestPart) {
            di.checkPoint.totalPaidPrincipal += uint96(amount - interestPart);
        }
    }

    function refreshPnL() external returns (uint256 profit, uint256 loss) {
        profit = accruedProfit;

        // Iterate all active credits to get the total profit
        for (uint256 i; i < activeCreditsHash.length; i++) {
            bytes32 hash = activeCreditsHash[i];
            (CreditInfo memory di, uint256 accruedInterest) = _refreshCredit(hash, deals[hash]);
            deals[hash] = di;
            profit += accruedInterest;
        }

        // :handle defaulted credits
        loss = accruedLoss;

        if (profit >= loss) {
            profit -= loss;
            loss = 0;
        } else {
            loss -= profit;
            profit = 0;
        }

        accruedProfit = 0;
        accruedLoss = 0;
    }

    function currentPnL() external view returns (uint256 profit, uint256 loss) {
        profit = accruedProfit;

        // Iterates all active loans to get the total profit
        for (uint256 i; i < activeCreditsHash.length; i++) {
            bytes32 hash = activeCreditsHash[i];
            (, uint256 accruedInterest) = _refreshCredit(hash, deals[hash]);
            profit += accruedInterest;
        }

        // :handle defaulted credits
        loss = accruedLoss;

        if (profit >= loss) {
            profit -= loss;
            loss = 0;
        } else {
            loss -= profit;
            profit = 0;
        }
    }

    function submitPrincipalWithdrawal(uint256 amount) external {}

    // todo provide an external view function for credit payment due list ?
}
