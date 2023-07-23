// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {CreditConfig} from "../CreditStructs.sol";
import {CalendarUnit} from "../../SharedDefs.sol";

interface IFlexCreditWithdrawal {
    function requestPrincipalWithdrawal(uint256 amount) external returns (bool availability);
}